#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideLocal } from './qwen-decide.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = path.join(ROOT, 'scripts', 'blender-vision-worker.py');

function candidates(state) {
  if (!state.head_morphed) return [
    { index: 1, role: 'tool', label: 'morph revised Gemini head region with scale 0.78 and widened smoothstep falloff', call: { operation: 'morph_head', scale: 0.78, falloff: 'smoothstep' } },
    { index: 2, role: 'tool', label: 'morph revised Gemini head region with scale 0.81 and widened smoothstep falloff to reduce shoulder-neck shelf', call: { operation: 'morph_head', scale: 0.81, falloff: 'smoothstep' } },
    { index: 3, role: 'tool', label: 'morph revised Gemini head region with scale 0.84 and widened cosine falloff', call: { operation: 'morph_head', scale: 0.84, falloff: 'cosine' } },
  ];
  if (!state.saved && state.head_morphed && state.falloff_applied) return [
    { index: 4, role: 'tool', label: 'lightly refine only Gemini falloff band with strength 0.08', call: { operation: 'refine', value: 0.08 } },
    { index: 5, role: 'tool', label: 'moderately refine only Gemini falloff band with strength 0.14', call: { operation: 'refine', value: 0.14 } },
    { index: 6, role: 'tool', label: 'save current morph for human review without extra smoothing', call: { operation: 'save' } },
  ];
  return [{ index: 6, role: 'tool', label: 'save current morph for human review', call: { operation: 'save' } }];
}

function execute(blender, blend, call) {
  const run = spawnSync(blender, ['--factory-startup', '--background', blend, '--python', WORKER], { encoding: 'utf8', timeout: 1200000, env: { ...process.env, JEV_BLENDER_REQUEST: JSON.stringify(call) } });
  if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  const line = run.stdout.split(/\r?\n/).find(value => value.includes('JEV_BLENDER_STATE='));
  return JSON.parse(line.slice(line.indexOf('JEV_BLENDER_STATE=') + 18));
}

async function main() {
  const [input, output] = process.argv.slice(2); fs.copyFileSync(input, output);
  let state = execute('blender', output, { operation: 'inspect' }); const trace = [];
  for (let step = 1; step <= 5; step++) {
    const options = candidates(state);
    const decision = await decideLocal({ goal: 'Revise the Gemini-reviewed head morph to remove the shoulder-neck shelf and anterior throat gap while locking all geometry below Z=1.325. Preserve face/skull shape uniformly and blend through the widened 1.325-1.425 band. Final visual approval is human.', app: 'Blender', candidates: options, context: JSON.stringify(state), recentActions: trace.map(x => JSON.stringify(x.call)), constraints: 'Choose one available atomic call. Gemini reviewed the previous result as REVISE and required: move the head boundary higher to Z=1.425, widen falloff to 1.325-1.425, remove posterior pivot offset, and avoid too-small 0.72 scale. Do not move locked vertices. Do not cut or bridge.', allowedActions: ['click_element'] });
    const selected = options.find(option => option.index === decision.targetIndex); if (!selected) throw new Error('invalid Jev tool selection');
    const before = structuredClone(state); state = execute('blender', output, selected.call); trace.push({ step, call: selected.call, label: selected.label, latencyMs: decision.latencyMs, before, after: state });
    if (selected.call.operation === 'save') { console.log(JSON.stringify({ status: 'done', visualReview: 'required', output, state, trace }, null, 2)); return; }
  }
  console.log(JSON.stringify({ status: 'max_steps', output, state, trace }, null, 2)); process.exitCode = 1;
}
main().catch(error => { console.error(error.message); process.exit(1); });
