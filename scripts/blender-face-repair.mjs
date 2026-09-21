#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  console.error('usage: npm run blender-face-repair -- /absolute/input.blend /absolute/output-dir');
  process.exit(2);
}
const input = path.resolve(inputArg);
const outputDir = path.resolve(outputArg);
if (!fs.existsSync(input)) throw new Error(`input Blend not found: ${input}`);
fs.mkdirSync(outputDir, { recursive: true });
const blender = process.env.BLENDER_BIN ?? 'blender';
const worker = path.join(projectDir, 'scripts', 'blender-face-repair.py');
const child = spawn(blender, ['--factory-startup', '--background', input, '--python', worker], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: { ...process.env, JEV_CU_BLEND_INPUT: input, JEV_CU_BLEND_OUTPUT_DIR: outputDir },
});
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('close', resolve);
});
if (code !== 0) process.exit(code ?? 1);
const logPath = path.join(outputDir, 'implementation-log.json');
const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
console.log(JSON.stringify({ status: log.status, output: log.output, renders: log.renders, ratio: log.structural_assertions.total_height_over_head_height }));
