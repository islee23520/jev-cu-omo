import test from 'node:test';
import assert from 'node:assert/strict';
import { decideLaya, shutdownLayaWorkers, toLayaRequest } from '../scripts/laya-decide.mjs';

const candidates = [
  { index: 56, role: 'button', label: 'previous month' },
  { index: 58, role: 'button', label: 'next month' },
];

test('Laya request uses the shared typed-decision schema and bounded candidates', () => {
  const request = toLayaRequest({ goal: 'go to previous month', app: 'Calendar', candidates });
  assert.equal(request.state.app, 'Calendar');
  assert.deepEqual(Object.keys(request.questions), ['target', 'action', 'done', 'risk']);
  assert.deepEqual(Object.keys(request.questions.target.criteria), ['i56', 'i58']);
});

test('Laya response normalizes to the shared computer-use decision contract', async () => {
  const request = async payload => ({
    answers: {
      target: { choice: 'i56', confidence: 0.87, probabilities: { i56: 0.87, i58: 0.13 } },
      action: { choice: 'click_element', confidence: 0.91 },
      done: { noul: 0.03 },
      risk: { noul: 0.02 },
    },
    model: 'convaiinnovations/laya', usage: { input_tokens: 123, output_tokens: 0 }, routing: { model: 'english' },
  });
  const decision = await decideLaya({ goal: 'go to previous month', app: 'Calendar', candidates, request });
  assert.equal(decision.targetIndex, 56);
  assert.equal(decision.action, 'click_element');
  assert.equal(decision.confidence, 0.87);
  assert.equal(decision.costUsd, 0);
  assert.equal(decision.usage.output_tokens, 0);
});

test('Laya binds a single planner-authorized action and leaves done/risk to local verification', async () => {
  const request = async () => ({ answers: {
    target: { choice: 'i56', confidence: 0.1, probabilities: { i56: 0.7, i58: 0.3 } },
    action: { choice: 'set_value' }, done: { noul: 0.9 }, risk: { noul: 0.8 },
  } });
  const decision = await decideLaya({ goal: 'previous', app: 'Calendar', candidates, allowedActions: ['click_element', 'wait', 'ask_user'], request });
  assert.equal(decision.action, 'click_element');
  assert.equal(decision.confidence, 0.7);
  assert.equal(decision.done, 0);
  assert.equal(decision.risk, 0);
  assert.equal(decision.laya.targetConfidence, 0.1);
});

test('Laya rejects a choice outside the candidates sent to the model', async () => {
  const request = async () => ({ answers: {
    target: { choice: 'i999', confidence: 0.99 }, action: { choice: 'click_element' },
    done: { noul: 0 }, risk: { noul: 0 },
  } });
  const decision = await decideLaya({ goal: 'go to previous month', app: 'Calendar', candidates, request });
  assert.equal(decision.targetIndex, null);
});

test.after(() => shutdownLayaWorkers());
