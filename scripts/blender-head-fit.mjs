#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { decideLocal } from './qwen-decide.mjs';

export const HEAD_FIT_PRESETS = [
  { index: 1, role: 'preset', label: 'conservative head fit: width/depth 82%, height 94%, broad neck blend', xy: 0.82, z: 0.94 },
  { index: 2, role: 'preset', label: 'natural adult head fit: width/depth 72%, height 90%, smooth neck blend', xy: 0.72, z: 0.90 },
  { index: 3, role: 'preset', label: 'compact realistic head fit: width/depth 65%, height 86%, narrow silhouette', xy: 0.65, z: 0.86 },
];

export function buildBlenderScript({ sourceObject, output, preset }) {
  return `import bpy, math, os\n` +
    `obj=bpy.data.objects[${JSON.stringify(sourceObject)}]\n` +
    `pivot_x=obj.location.x\n` +
    `pivot_y=obj.location.y\n` +
    `pivot_z=1.34\n` +
    `blend_start=1.28\n` +
    `blend_end=1.43\n` +
    `xy=${preset.xy}\n` +
    `zs=${preset.z}\n` +
    `for v in obj.data.vertices:\n` +
    `    world=obj.matrix_world @ v.co\n` +
    `    if world.z <= blend_start: continue\n` +
    `    t=max(0.0,min(1.0,(world.z-blend_start)/(blend_end-blend_start)))\n` +
    `    t=t*t*(3.0-2.0*t)\n` +
    `    sx=1.0+(xy-1.0)*t\n` +
    `    sz=1.0+(zs-1.0)*t\n` +
    `    world.x=pivot_x+(world.x-pivot_x)*sx\n` +
    `    world.y=pivot_y+(world.y-pivot_y)*sx\n` +
    `    world.z=pivot_z+(world.z-pivot_z)*sz\n` +
    `    v.co=obj.matrix_world.inverted() @ world\n` +
    `obj.data.update()\n` +
    `obj[\"jev_cu_head_fit_preset\"]=${JSON.stringify(preset.label)}\n` +
    `obj[\"jev_cu_head_fit_xy\"]=${preset.xy}\n` +
    `obj[\"jev_cu_head_fit_z\"]=${preset.z}\n` +
    `bpy.context.scene[\"jev_cu_human_visual_review_required\"]=True\n` +
    `bpy.ops.wm.save_as_mainfile(filepath=${JSON.stringify(output)})\n` +
    `print(\"JEV_BLENDER_APPLIED=${preset.index}\")\n`;
}

export async function runHeadFit({ input, output, sourceObject = 'Female_Base_Assembly', decide = decideLocal, blender = 'blender' }) {
  const startedAt = Date.now();
  const decision = await decide({
    goal: 'Choose the single proportion preset that best connects an oversized character head to a natural adult torso. Final visual approval is performed by a human.',
    app: 'Blender',
    candidates: HEAD_FIT_PRESETS,
    context: 'Connected female body mesh, height 1.65 m. Current head cross-section is about 0.53 m wide at z=1.40 while upper torso width is about 0.63 m at z=1.25. Preserve the torso and smoothly blend changes through the neck from z=1.28 to z=1.43.',
    constraints: 'Select a preset only. Do not claim visual approval. Prefer natural adult proportions and a smooth neck transition.',
    allowedActions: ['click_element'],
  });
  const preset = HEAD_FIT_PRESETS.find(item => item.index === decision.targetIndex);
  if (!preset) throw new Error('decision did not select a valid head-fit preset');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const scriptPath = path.join(os.tmpdir(), `jev-cu-blender-${process.pid}.py`);
  fs.writeFileSync(scriptPath, buildBlenderScript({ sourceObject, output, preset }));
  const appliedAt = Date.now();
  const run = spawnSync(blender, ['--factory-startup', '--background', input, '--python', scriptPath], { encoding: 'utf8', timeout: 20 * 60_000 });
  fs.rmSync(scriptPath, { force: true });
  if (run.error) throw run.error;
  if (run.status !== 0 || !run.stdout.includes(`JEV_BLENDER_APPLIED=${preset.index}`)) {
    throw new Error(`Blender apply failed: ${run.stderr || run.stdout}`);
  }
  return {
    status: 'applied',
    visualReview: 'required',
    preset,
    decision: { targetIndex: decision.targetIndex, targetLabel: decision.targetLabel, model: decision.model, latencyMs: decision.latencyMs },
    timing: { totalMs: Date.now() - startedAt, applyMs: Date.now() - appliedAt },
    output,
  };
}

async function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('usage: node scripts/blender-head-fit.mjs input.blend output.blend');
  console.log(JSON.stringify(await runHeadFit({ input: path.resolve(input), output: path.resolve(output) }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(error => { console.error(error.message); process.exit(1); });
