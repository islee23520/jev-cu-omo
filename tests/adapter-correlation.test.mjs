import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requestLaya, shutdownLayaWorkers } from '../scripts/laya-decide.mjs';
import { askLocal } from '../scripts/qwen-decide.mjs';

const tempRoots = [];

async function fakeWorker(source) {
  const root = await mkdtemp(path.join(tmpdir(), 'jev-adapter-'));
  tempRoots.push(root);
  const executable = path.join(root, 'worker');
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`);
  await chmod(executable, 0o755);
  return executable;
}

async function dispatchAfter(promise, sink) {
  const value = await promise;
  sink(value);
  return value;
}

function qwenResponse({ model = 'qwen3:8b', content, json }) {
  return {
    ok: true,
    status: 200,
    json: json ?? (async () => ({ model, message: { content: JSON.stringify(content) } })),
  };
}

test('startup silence times out before any dependent write', { timeout: 1_000 }, async () => {
  const python = await fakeWorker("process.stdin.resume();");
  const writes = [];

  await assert.rejects(
    dispatchAfter(requestLaya({ state: {}, questions: {} }, { python, timeoutMs: 40 }), value => writes.push(value)),
    /timed out/i,
  );
  assert.equal(writes.length, 0);
});

test('late response after timeout cannot satisfy the next request', { timeout: 1_000 }, async () => {
  const python = await fakeWorker(`
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    let first;
    console.log(JSON.stringify({ ready: true, model: 'english' }));
    lines.on('line', line => {
      const request = JSON.parse(line);
      if (!first) { first = request; return; }
      console.log(JSON.stringify({ request_id: first.request_id, answers: { marker: 'A-late' }, model: 'convaiinnovations/laya:english' }));
      console.log(JSON.stringify({ request_id: request.request_id, answers: { marker: 'B' }, model: 'convaiinnovations/laya:english' }));
    });
  `);

  await assert.rejects(requestLaya({ state: { marker: 'A' }, questions: {} }, { python, timeoutMs: 500 }), /timed out/i);
  const second = await requestLaya({ state: { marker: 'B' }, questions: {} }, { python, timeoutMs: 1_000 });
  assert.equal(second.answers.marker, 'B');
});

test('body timeout aborts before JSON completion and any dependent write', { timeout: 1_000 }, async () => {
  const writes = [];
  let aborted = false;
  const fetchImpl = async (_url, init) => {
    init.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return qwenResponse({ json: async () => new Promise(() => {}) });
  };

  await assert.rejects(
    dispatchAfter(askLocal({ goal: 'g', app: 'Calculator', timeoutMs: 40, fetchImpl }), value => writes.push(value)),
    /timed out/i,
  );
  assert.equal(aborted, true);
  assert.equal(writes.length, 0);
});

test('provider mismatch rejects before any dependent write', async () => {
  const writes = [];
  const fetchImpl = async () => qwenResponse({
    model: 'other:latest',
    content: { target: 'ask_user', action: 'ask_user', done: false, risk: false },
  });

  await assert.rejects(
    dispatchAfter(askLocal({ goal: 'g', app: 'Calculator', model: 'qwen3:8b', fetchImpl }), value => writes.push(value)),
    /model mismatch/i,
  );
  assert.equal(writes.length, 0);
});

test('requested and reported model provenance stay distinct and unverifiable fields stay unproven', async () => {
  const fetchImpl = async () => qwenResponse({
    model: 'qwen3:8b',
    content: { target: 'ask_user', action: 'ask_user', done: false, risk: false },
  });

  const result = await askLocal({ goal: 'g', app: 'Calculator', model: 'qwen3:8b', fetchImpl });
  assert.equal(result.requestedModel, 'qwen3:8b');
  assert.equal(result.reportedModel, 'qwen3:8b');
  assert.deepEqual(result.provenance, { checkpoint: 'unproven', revision: 'unproven', digest: 'unproven' });
});

test('uncorrelated response is not accepted', { timeout: 1_000 }, async () => {
  const python = await fakeWorker(`
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    console.log(JSON.stringify({ ready: true, model: 'english' }));
    lines.once('line', () => console.log(JSON.stringify({ answers: { marker: 'wrong' } })));
  `);
  const writes = [];

  await assert.rejects(
    dispatchAfter(requestLaya({ state: {}, questions: {} }, { python, timeoutMs: 1_000 }), value => writes.push(value)),
    /correlation|request_id/i,
  );
  assert.equal(writes.length, 0);
});

test('terminal worker exit rejects pending request before any dependent write', { timeout: 1_000 }, async () => {
  const python = await fakeWorker(`
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    console.log(JSON.stringify({ ready: true, model: 'english' }));
    lines.once('line', () => process.exit(7));
  `);
  const writes = [];

  await assert.rejects(
    dispatchAfter(requestLaya({ state: {}, questions: {} }, { python, timeoutMs: 500 }), value => writes.push(value)),
    /exited \(7\)/i,
  );
  assert.equal(writes.length, 0);
});

test.after(async () => {
  shutdownLayaWorkers();
  await Promise.all(tempRoots.map(root => rm(root, { recursive: true, force: true })));
});
