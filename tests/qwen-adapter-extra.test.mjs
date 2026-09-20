import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLocal } from '../scripts/qwen-decide.mjs';
import { createCliDriver } from '../scripts/cua-cli.mjs';
import { createJevTool } from '../extension/jev-cu.mjs';

test('allowedActions 会收紧动作枚举', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ target: 'i1', action: 'click_element', done: false, risk: false }) } }) };
  };
  await decideLocal({ goal: 'g', app: 'Calculator', candidates: [{ index: 1, role: 'button', label: 'x' }],
    allowedActions: ['click_element', 'wait'], fetchImpl });
  assert.deepEqual(seen[0].format.properties.action.enum, ['click_element', 'wait']);
});

test('会话被守护进程结束后先 start_session 复活再重试', async () => {
  const calls = [];
  const invoke = async (name, args) => {
    calls.push(name);
    if (name === 'list_apps') return { apps: [{ pid: 123, running: true, bundle_id: 'com.apple.calculator' }] };
    if (name === 'list_windows') return { windows: [{ pid: 123, window_id: 456 }] };
    if (name === 'start_session') return { session: args.session };
    if (calls.filter(c => c === 'get_window_state').length === 1) {
      throw new Error("session 'base' has ended; tool call 'get_window_state' was rejected. Call start_session ...");
    }
    return {
      pid: 123, window_id: 456, snapshot_id: 's00000001',
      elements: [{ element_index: 1, element_token: 's00000001:1', role: 'AXButton', label: '7', depth: 0 }],
      tree_markdown: '- [1] AXButton (7)',
    };
  };
  const driver = createCliDriver({ pid: 123, windowId: 456, session: 'base', invoke });
  await driver.bind('Calculator');
  const ax = await driver.observe();
  assert.match(ax, /1 button 7/);
  assert.deepEqual(calls, ['list_apps', 'list_windows', 'get_window_state', 'start_session', 'get_window_state']);
});

test('stepGoals 逐旁提供给循环，决策仍由后端选元素', async () => {
  const seenGoals = [];
  const tool = createJevTool({
    createDriver: async () => ({ selectTarget: () => {} }),
    decide: async input => { seenGoals.push(input.goal); return { action: 'click_element', targetIndex: 1, confidence: 1, risk: 0, done: 0 }; },
    run: async options => {
      for (const step of [1, 2]) {
        const planned = await options.resources(step, null);
        await options.decide({ goal: planned.jevGoal, candidates: [{ index: 1 }] });
      }
      return { status: 'dry_run', steps: 2 };
    },
  });
  await tool.execute('stepgoals', { operation: 'run', app: 'Calculator', pid: 1, windowId: 1,
    goal: 'compute', stepGoals: ['click the digit 7 button', 'click the equals button'] });
  assert.deepEqual(seenGoals, ['click the digit 7 button', 'click the equals button']);
});
