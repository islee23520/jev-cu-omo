import test from 'node:test';
import assert from 'node:assert/strict';
import { createJevTool, matchesVerification } from '../extension/jev-cu.mjs';

const snapshot = { elements: [
  { element_index: 1, role: 'AXStaticText', label: 'Result', value: '42' },
  { element_index: 2, role: 'AXButton', label: '42', value: '' },
] };

test('verification matches an exact observed role, label and value', () => {
  assert.equal(matchesVerification(snapshot, { role: 'AXStaticText', label: 'Result', value: '42' }), true);
  assert.equal(matchesVerification(snapshot, { role: 'AXStaticText', label: 'Result', value: '\u200e42' }), true, '方向标记应被忽略');
  assert.equal(matchesVerification(snapshot, { role: 'AXStaticText', label: 'Result', value: '4' }), false);
  assert.equal(matchesVerification(snapshot, { role: 'AXButton', label: 'Result', value: '42' }), false);
});

test('verification ignores thousands separators in display values', () => {
  const big = { elements: [{ element_index: 1, role: 'AXStaticText', label: 'Result', value: '\u200e3,687,600' }] };
  assert.equal(matchesVerification(big, { role: 'AXStaticText', value: '3687600' }), true);
  assert.equal(matchesVerification(big, { role: 'AXStaticText', value: '368760' }), false);
});

test('observe uses the driver without requesting a Jev key or decision', async () => {
  const calls = [];
  const tool = createJevTool({
    createDriver: () => ({ bind: async app => calls.push(app), observe: async () => 'AX', getSnapshot: () => snapshot }),
    getKey: () => { throw new Error('must not read a key'); },
  });
  const result = await tool.execute('observe', { operation: 'observe', app: 'Calculator', pid: 10, windowId: 20 });
  assert.deepEqual(calls, ['Calculator']);
  assert.equal(result.details.status, 'observed');
  assert.deepEqual(result.details.elements, snapshot.elements);
});

test('execution without a verification criterion is rejected before binding', async () => {
  const tool = createJevTool({ createDriver: () => { throw new Error('must not bind'); } });
  await assert.rejects(tool.execute('run', {
    operation: 'run', app: 'Calculator', pid: 10, windowId: 20, goal: 'calculate', dryRun: false,
  }), /verify/);
});

test('real decision is constrained to supported actions and exact snapshot verification', async () => {
  let chosen;
  let clicked = false;
  const tool = createJevTool({
    createDriver: () => ({ selectTarget: index => { chosen = index; }, getSnapshot: () => snapshot }),
    getKey: () => 'test-only',
    decide: async () => ({ action: 'click_element', targetIndex: 1, confidence: 1, risk: 0, done: 0 }),
    run: async options => {
      assert.equal(options.dryRun, true);
      assert.equal(options.verify(), true);
      const decision = await options.decide({ candidates: [{ index: 1 }] });
      assert.equal(decision.action, 'click_element');
      clicked = !options.dryRun;
      return { status: 'dry_run', steps: 0 };
    },
  });
  const result = await tool.execute('dry', { operation: 'run', app: 'Calculator', pid: 10, windowId: 20,
    goal: 'calculate', verify: { role: 'AXStaticText', label: 'Result', value: '42' } });
  assert.equal(chosen, 1);
  assert.equal(clicked, false);
  assert.equal(result.details.status, 'dry_run');
});

test('unsupported actions and missing text cannot reach driver execution', async () => {
  for (const action of ['click_at', 'drag', 'type_text', 'set_value', 'press_key']) {
    const tool = createJevTool({
      createDriver: () => ({ selectTarget: () => { throw new Error('must not select'); } }),
      getKey: () => 'test-only', decide: async () => ({ action, targetIndex: 1 }),
      run: async options => options.decide({ candidates: [{ index: 1 }] }),
    });
    await assert.rejects(tool.execute('unsupported', {
      operation: 'run', app: 'Calculator', pid: 10, windowId: 20, goal: 'test',
    }), /unsupported|resources/);
  }
});

test('unverified done is returned as an error rather than a successful task', async () => {
  const tool = createJevTool({ createDriver: () => ({}), getKey: () => 'test-only',
    run: async () => ({ status: 'done', verified: false }) });
  const result = await tool.execute('unverified', { operation: 'run', app: 'Calculator', pid: 10, windowId: 20,
    goal: 'test', verify: { role: 'AXStaticText', value: '42' }, dryRun: false });
  assert.equal(result.isError, true);
});

test('Laya backend does not request a TypeSafe key', async () => {
  const previous = process.env.JEV_CU_DECIDER;
  process.env.JEV_CU_DECIDER = 'laya';
  try {
    const tool = createJevTool({
      createDriver: async () => ({ selectTarget: () => {} }),
      getKey: () => { throw new Error('must not read TypeSafe key'); },
      run: async options => ({ status: 'dry_run', decision: await options.decide({
        goal: 'press 7', app: 'Calculator', candidates: [{ index: 5, role: 'button', label: '7' }],
      }) }),
      decide: async input => ({ action: 'click_element', targetIndex: input.candidates[0].index, confidence: 0.9, risk: 0, done: 0 }),
    });
    const result = await tool.execute('laya-no-key', { operation: 'run', app: 'Calculator', pid: 1, windowId: 1, goal: 'press 7' });
    assert.equal(result.details.status, 'dry_run');
  } finally {
    if (previous === undefined) delete process.env.JEV_CU_DECIDER; else process.env.JEV_CU_DECIDER = previous;
  }
});

test('tool surface exposes a bounded candidate budget for Laya', () => {
  const tool = createJevTool();
  assert.equal(tool.parameters.properties.candidateMax.default, 8);
  assert.equal(tool.parameters.properties.candidateMax.maximum, 20);
});

test('base Laya blocks real execution unless explicitly enabled', async () => {
  const previousBackend = process.env.JEV_CU_DECIDER;
  const previousAllow = process.env.JEV_CU_LAYA_ALLOW_REAL;
  process.env.JEV_CU_DECIDER = 'laya';
  delete process.env.JEV_CU_LAYA_ALLOW_REAL;
  try {
    const tool = createJevTool({ createDriver: () => { throw new Error('must not bind'); } });
    await assert.rejects(tool.execute('laya-real', {
      operation: 'run', app: 'Calculator', pid: 1, windowId: 1, goal: 'press 7', dryRun: false,
      verify: { role: 'AXStaticText', value: '7' },
    }), /real execution is disabled/);
  } finally {
    if (previousBackend === undefined) delete process.env.JEV_CU_DECIDER; else process.env.JEV_CU_DECIDER = previousBackend;
    if (previousAllow === undefined) delete process.env.JEV_CU_LAYA_ALLOW_REAL; else process.env.JEV_CU_LAYA_ALLOW_REAL = previousAllow;
  }
});
