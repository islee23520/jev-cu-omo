import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('package exposes a portable verified female face repair command', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['blender-face-repair'], 'node scripts/blender-face-repair.mjs');
  assert.ok(fs.existsSync(new URL('../scripts/blender-face-repair.mjs', import.meta.url)));
  assert.ok(fs.existsSync(new URL('../scripts/blender-face-repair.py', import.meta.url)));
});

test('Blender repair worker takes input and output paths from environment', () => {
  const source = fs.readFileSync(new URL('../scripts/blender-face-repair.py', import.meta.url), 'utf8');
  assert.match(source, /JEV_CU_BLEND_INPUT/);
  assert.match(source, /JEV_CU_BLEND_OUTPUT_DIR/);
  assert.doesNotMatch(source, /\/Users\/ilseoblee\/workspace/);
  assert.match(source, /aa6d5625b9279046d30c1e8b3a309b56646207cff1ee655530716d52de22d1af/);
  assert.match(source, /8c1e401fb351df0b7fef3def31383d5d88ce67600045fcd0f4fa61dc9c03792d/);
});
