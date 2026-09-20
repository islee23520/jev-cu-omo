import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnswers, decideLocal } from '../scripts/qwen-decide.mjs';
import { createJevTool } from '../extension/jev-cu.mjs';

test('布尔与枚举输出映射回上游 answers 形状', () => {
  const answers = toAnswers({ target: 'i56', action: 'click_element', done: false, risk: false });
  assert.equal(answers.target.choice, 'i56');
  assert.equal(answers.action.choice, 'click_element');
  assert.equal(answers.done.noul, 0);
  assert.equal(answers.risk.noul, 0);
  assert.equal(toAnswers({ target: null, action: 'ask_user', done: true, risk: true }).done.noul, 1);
});

test('请求使用 JSON Schema 枚举、禁用思考并且温度为 0', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ model: 'qwen3:8b', message: { content: JSON.stringify({ target: 'i56', action: 'click_element', done: false, risk: false }) }, prompt_eval_count: 100, eval_count: 8 }) };
  };
  const result = await decideLocal({
    goal: 'next month', app: 'Calendar',
    candidates: [{ index: 56, role: 'button', label: 'next month' }, { index: 57, role: 'button', label: 'today' }],
    fetchImpl,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, 'http://127.0.0.1:11435/api/chat');
  assert.deepEqual(seen[0].body.format.properties.target.enum, ['i56', 'i57']);
  assert.equal(seen[0].body.think, false);
  assert.equal(seen[0].body.options.temperature, 0);
  assert.equal(result.targetIndex, 56);
  assert.equal(result.targetLabel, 'button: next month');
  assert.equal(result.action, 'click_element');
  assert.equal(result.usage.input_tokens, 100);
  assert.equal(result.costUsd, 0);
});

test('非法 JSON、缺字段和 HTTP 错误都显式失败', async () => {
  await assert.rejects(decideLocal({ goal: 'g', app: 'Calendar', fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) }) }), /JSON/);
  await assert.rejects(decideLocal({ goal: 'g', app: 'Calendar', fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content: '{"target":"i1"}' } }) }) }), /必填字段/);
  await assert.rejects(decideLocal({ goal: 'g', app: 'Calendar', fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'busy' }) }) }), /busy/);
});

test('扩展在 qwen 后端下不读取 TypeSafe 密钥', async () => {
  const okResponse = () => ({ ok: true, json: async () => ({ message: { content: JSON.stringify({ target: 'i5', action: 'click_element', done: false, risk: false }) } }) });
  const tool = createJevTool({
    createDriver: async () => ({ selectTarget: () => {} }),
    decide: input => decideLocal({ ...input, fetchImpl: async () => okResponse() }),
    getKey: () => { throw new Error('must not read key'); },
    run: async options => options.decide({ candidates: [{ index: 5, role: 'button', label: '7' }] }),
  });
  const result = await tool.execute('qwen-nokey', { operation: 'run', app: 'Calculator', pid: 1, windowId: 1, goal: 'enter 7' });
  assert.equal(result.details.targetIndex, 5);
  // 未校准后端：选中目标时补 1.0 让上游策略运行，文档中声明非校准。
  assert.equal(result.details.confidence, 1);
});
