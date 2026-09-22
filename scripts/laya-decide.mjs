#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildQuestions, normalizeDecision } from './jev-decide.mjs';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_LAYA_PYTHON = process.env.JEV_CU_LAYA_PYTHON ?? path.join(PROJECT_DIR, '.venv-laya', 'bin', 'python');
export const DEFAULT_LAYA_MODEL = process.env.JEV_CU_LAYA_MODEL ?? 'english';
const workers = new Map();
const IDLE_MS = Number(process.env.JEV_CU_LAYA_IDLE_MS ?? 5000);

export function shutdownLayaWorkers() {
  for (const worker of workers.values()) {
    worker.child.stdin.end();
    worker.child.kill('SIGTERM');
  }
  workers.clear();
}

export function toLayaRequest({ goal, app, candidates = [], context = '', recentActions = [], constraints = '', allowedActions }) {
  const { criteria, questions } = buildQuestions(goal, candidates);
  if (allowedActions) questions.action.criteria = Object.fromEntries(Object.entries(questions.action.criteria).filter(([key]) => allowedActions.includes(key)));
  return {
    state: { goal, app, context: String(context).slice(0, 1500), candidates: Object.entries(criteria).map(([id, desc]) => ({ id, desc })), recent_actions: recentActions.slice(-6), constraints },
    questions, criteria,
  };
}

function startWorker({ python, model }) {
  const child = spawn(python, [path.join(PROJECT_DIR, 'scripts', 'laya-worker.py'), '--model', model], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, USE_TF: '0' },
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let startupResolve; let startupReject;
  const ready = new Promise((resolve, reject) => { startupResolve = resolve; startupReject = reject; });
  const worker = { child, ready, pending, idleTimer: null, started: false };
  const rejectPending = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  lines.on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { value = { error: `invalid JSON: ${line.slice(0, 200)}` }; }
    if (!worker.started) {
      worker.started = true;
      if (value.ready) startupResolve(value); else startupReject(new Error(value.error ?? 'Laya worker failed to start'));
      return;
    }
    if (typeof value.request_id !== 'string') {
      const error = new Error('Laya response missing request_id correlation');
      rejectPending(error);
      child.kill('SIGTERM');
      return;
    }
    const request = pending.get(value.request_id);
    if (!request) return;
    pending.delete(value.request_id);
    if (value.error) request.reject(new Error(`Laya prediction failed: ${value.error}`)); else request.resolve(value);
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 16_000) stderr = stderr.slice(-16_000); });
  child.once('error', error => { startupReject(error); rejectPending(error); });
  child.once('close', code => {
    const error = new Error(`Laya worker exited (${code}): ${stderr.trim()}`);
    startupReject(error); rejectPending(error);
    workers.delete(`${python}\0${model}`);
  });
  return worker;
}

export async function requestLaya(payload, { python = DEFAULT_LAYA_PYTHON, model = DEFAULT_LAYA_MODEL, timeoutMs = Number(process.env.JEV_CU_LAYA_TIMEOUT_MS ?? 180_000) } = {}) {
  const key = `${python}\0${model}`;
  const worker = workers.get(key) ?? startWorker({ python, model });
  workers.set(key, worker);
  return new Promise((resolve, reject) => {
    if (worker.idleTimer) clearTimeout(worker.idleTimer);
    const requestId = randomUUID();
    const scheduleIdle = () => {
      if (worker.pending.size) return;
      worker.idleTimer = setTimeout(() => {
        if (!worker.pending.size) {
          worker.child.stdin.end();
          worker.child.kill('SIGTERM');
          workers.delete(key);
        }
      }, IDLE_MS);
      worker.idleTimer.unref();
    };
    const pending = {
      resolve: value => {
        clearTimeout(timer);
        resolve({
          ...value,
          requestedModel: model,
          reportedModel: value.model ?? 'unproven',
          provenance: value.provenance ?? { checkpoint: 'unproven', revision: 'unproven', digest: 'unproven' },
        });
        scheduleIdle();
      },
      reject: error => { clearTimeout(timer); reject(error); scheduleIdle(); },
    };
    worker.pending.set(requestId, pending);
    const timer = setTimeout(() => {
      worker.pending.delete(requestId);
      if (!worker.started) {
        worker.child.kill('SIGTERM');
        workers.delete(key);
      }
      reject(new Error(`Laya prediction timed out after ${timeoutMs}ms`));
      scheduleIdle();
    }, timeoutMs);
    worker.ready.then(() => {
      if (!worker.pending.has(requestId)) return;
      worker.child.stdin.write(`${JSON.stringify({ ...payload, request_id: requestId })}\n`, error => {
        if (!error || !worker.pending.delete(requestId)) return;
        pending.reject(error);
      });
    }, error => {
      if (!worker.pending.delete(requestId)) return;
      pending.reject(error);
    });
  });
}

export async function decideLaya({ goal, app, candidates = [], context = '', recentActions = [], constraints = '', allowedActions, request = requestLaya, ...requestOptions }) {
  const startedAt = Date.now();
  const { state, questions, criteria } = toLayaRequest({ goal, app, candidates, context, recentActions, constraints, allowedActions });
  const result = await request({ state, questions }, requestOptions);
  const decision = normalizeDecision(result.answers, criteria);
  const targetProbability = decision.targetKey ? Number(decision.probabilities?.[decision.targetKey]) : null;
  const plannedActions = (allowedActions ?? []).filter(action => !['wait', 'ask_user'].includes(action));
  const boundAction = plannedActions.length === 1 ? plannedActions[0] : decision.action;
  return {
    ...decision,
    action: boundAction,
    // Laya's `confidence` is not the selected option probability. The local
    // policy gate needs the probability of the target actually selected.
    confidence: Number.isFinite(targetProbability) ? targetProbability : decision.confidence,
    // Completion is proven by the caller's exact postcondition and sensitive
    // actions are gated from the selected label locally. Base Laya's zero-shot
    // done/risk heads are not calibrated for this GUI domain.
    done: 0,
    risk: 0,
    usage: result.usage ?? { input_tokens: 0, output_tokens: 0 },
    latencyMs: result.latencyMs ?? Date.now() - startedAt,
    costUsd: 0,
    model: result.reportedModel ?? result.model ?? 'unproven',
    requestedModel: result.requestedModel ?? requestOptions.model ?? DEFAULT_LAYA_MODEL,
    reportedModel: result.reportedModel ?? result.model ?? 'unproven',
    provenance: result.provenance ?? { checkpoint: 'unproven', revision: 'unproven', digest: 'unproven' },
    routing: result.routing,
    raw: result,
    laya: { targetConfidence: decision.confidence, targetProbability },
  };
}
