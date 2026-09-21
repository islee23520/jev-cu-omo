import test from 'node:test';
import assert from 'node:assert/strict';
import { HEAD_FIT_PRESETS, buildBlenderScript, runHeadFit } from '../scripts/blender-head-fit.mjs';

test('Blender head-fit presets expose bounded semantic choices', () => {
  assert.deepEqual(HEAD_FIT_PRESETS.map(x => x.index), [1, 2, 3]);
  for (const preset of HEAD_FIT_PRESETS) {
    assert.ok(preset.xy >= 0.6 && preset.xy <= 0.9);
    assert.ok(preset.z >= 0.8 && preset.z <= 1);
  }
});

test('generated Blender script preserves torso and marks human visual review', () => {
  const script = buildBlenderScript({ sourceObject: 'Body', output: '/tmp/out.blend', preset: HEAD_FIT_PRESETS[1] });
  assert.match(script, /world\.z <= blend_start/);
  assert.match(script, /jev_cu_human_visual_review_required/);
  assert.match(script, /save_as_mainfile/);
});

test('runner applies the exact preset selected by the decision backend', async () => {
  let seen;
  const decide = async input => { seen = input; return { targetIndex: 2, targetLabel: input.candidates[1].label, model: 'test', latencyMs: 4 }; };
  await assert.rejects(
    runHeadFit({ input: '/tmp/in.blend', output: '/tmp/out.blend', decide, blender: '/definitely/missing/blender' }),
    /ENOENT/,
  );
  assert.equal(seen.app, 'Blender');
  assert.deepEqual(seen.allowedActions, ['click_element']);
  assert.equal(seen.candidates.length, 3);
});
