import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Gemini boundary worker locks the reviewed lower region', () => {
  const source = fs.readFileSync(new URL('../scripts/blender-vision-worker.py', import.meta.url), 'utf8');
  assert.match(source, /LOCK_Z = 1\.325/);
  assert.match(source, /HEAD_Z = 1\.425/);
  assert.match(source, /PIVOT_Y_OFFSET = 0\.0/);
  assert.match(source, /smoothstep/);
});

test('Jev runner receives bounded revised morph choices', () => {
  const source = fs.readFileSync(new URL('../scripts/blender-vision-autonomous.mjs', import.meta.url), 'utf8');
  assert.match(source, /scale: 0\.78/);
  assert.match(source, /scale: 0\.81/);
  assert.match(source, /scale: 0\.84/);
  assert.match(source, /Gemini reviewed the previous result as REVISE/);
});
