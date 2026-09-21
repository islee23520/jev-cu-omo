import os from 'node:os';
import path from 'node:path';
import { runTask } from '../scripts/loop.mjs';
import { decide as jevDecide, loadApiKey } from '../scripts/jev-decide.mjs';
import { decideLocal } from '../scripts/qwen-decide.mjs';
import { decideLaya } from '../scripts/laya-decide.mjs';

const activeWindows = new Set();
const supportedActions = new Set(['click_element', 'set_value', 'type_text', 'press_key', 'scroll', 'ask_user']);
const defaultTraceDir = () => process.env.JEV_CU_TRACE_DIR || path.join(os.homedir(), '.local', 'state', 'jev-cu', 'runs');

export function matchesVerification(snapshot, expected) {
  // AX 展示值可能带方向标记/零宽字符/千分位逗号；比较前归一化。
  const displayValue = value => String(value ?? '').replace(/[\u200e\u200f\u200b\u00a0]/g, '').replace(/,/g, '').trim();
  return snapshot?.elements?.some(element =>
    element.role === expected.role && displayValue(element.value) === displayValue(expected.value) &&
    (expected.label === undefined || element.label === expected.label)) ?? false;
}

export function createJevTool({
  createDriver = async options => (await import('../scripts/cua-cli.mjs')).createCliDriver(options),
  run = runTask,
  decide = jevDecide,
  getKey = () => loadApiKey({ envFile: process.env.JEV_CU_ENV_FILE || path.join(os.homedir(), '.config', 'jev-cu', 'typesafe.env') }),
} = {}) {
  const configuredBackend = process.env.JEV_CU_DECIDER ?? 'jev';
  const selectedDecide = decide !== jevDecide
    ? decide
    : configuredBackend === 'laya'
      ? decideLaya
      : configuredBackend === 'qwen'
        ? decideLocal
        : jevDecide;
  const needsTypeSafeKey = selectedDecide === jevDecide;
  return {
    name: 'jev_cu',
    label: 'Jev Computer Use',
    description: 'Observe a native macOS window or use a configured typed decision backend (TypeSafe Jev, local Laya, or local Qwen) to operate it through cua-driver. Browser tasks use Aside instead. Default dry-run; real execution requires an exact observable verification criterion.',
    promptSnippet: 'Native macOS GUI observation and verified Jev-driven actions',
    promptGuidelines: [
      'Use jev_cu observe first to obtain roles, labels and values. Ground verify in the actual observed result control, not a button whose label mentions the desired result.',
      'Use jev_cu run with dryRun true before a new flow; use dryRun false only for user-authorized actions. Confirm/escalate/error are not success.',
    ],
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['operation', 'app', 'pid', 'windowId'],
      properties: {
        operation: { type: 'string', enum: ['observe', 'run'] },
        app: { type: 'string', enum: ['Calculator', 'TextEdit', 'Calendar'] },
        pid: { type: 'integer', minimum: 1 },
        windowId: { type: 'integer', minimum: 1 },
        goal: { type: 'string', minLength: 1 },
        plan: { type: 'string', description: 'Planner-provided step plan; the decision model only picks which element, not what to do.' },
        stepGoals: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 15, description: 'Per-step goals from the planner; step N uses stepGoals[N-1]. The decision model still only picks the element.' },
        dryRun: { type: 'boolean', default: true },
        maxSteps: { type: 'integer', minimum: 1, maximum: 15, default: 5 },
        verify: {
          type: 'object', additionalProperties: false, required: ['role', 'value'],
          properties: { role: { type: 'string', minLength: 1 }, label: { type: 'string' }, value: { type: 'string' } },
        },
        resources: {
          type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, key: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] } },
        },
        candidateMax: { type: 'integer', minimum: 2, maximum: 20, default: 8, description: 'Maximum candidates sent to the decision backend. Laya should normally use 3-8.' },
      },
    },
    async execute(toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('Jev-cu cancelled');
      if (params.operation === 'run' && !params.goal) throw new Error('goal is required');
      if (params.operation === 'run' && params.dryRun === false && !params.verify) {
        throw new Error('verify is required for real execution');
      }
      if (configuredBackend === 'laya' && params.operation === 'run' && params.dryRun === false && process.env.JEV_CU_LAYA_ALLOW_REAL !== '1') {
        throw new Error('base Laya real execution is disabled; set JEV_CU_LAYA_ALLOW_REAL=1 only for explicit verified experiments');
      }
      const resourceActions = ['click_element', 'wait', 'ask_user', 'scroll'];
      if (params.resources?.text !== undefined) resourceActions.push('type_text', 'set_value');
      if (params.resources?.key) resourceActions.push('press_key');
      const staticResources = params.resources ?? {};
      const resources = Array.isArray(params.stepGoals)
        ? async step => ({ ...staticResources, jevGoal: params.stepGoals[step - 1] })
        : staticResources;
      const windowKey = `${params.pid}:${params.windowId}`;
      if (activeWindows.has(windowKey)) throw new Error('Jev-cu is already operating this window');
      activeWindows.add(windowKey);
      try {
        const driver = await createDriver({ pid: params.pid, windowId: params.windowId, session: `jev-cu-${toolCallId}`, signal });
        if (params.operation === 'observe') {
          await driver.bind(params.app);
          await driver.observe({ full: true });
          const snapshot = driver.getSnapshot();
          const details = { status: 'observed', ...snapshot };
          return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
        }
        const apiKey = needsTypeSafeKey ? getKey() : null;
        const result = await run({
          driver, appName: params.app, goal: params.goal, plan: params.plan ?? '',
          dryRun: params.dryRun ?? true, maxSteps: params.maxSteps ?? 5,
          candidateMax: params.candidateMax ?? (selectedDecide === decideLaya ? 8 : 40),
          allowedApps: ['Calculator', 'TextEdit', 'Calendar'],
          resources, traceDir: defaultTraceDir(), emit: () => {},
          verify: params.verify ? () => matchesVerification(driver.getSnapshot(), params.verify) : undefined,
          decide: async input => {
            if (signal?.aborted) throw new Error('Jev-cu cancelled');
            const decision = await selectedDecide(needsTypeSafeKey
              ? { ...input, apiKey, maxRetries: 0, timeoutMs: 20_000 }
              : { ...input, allowedActions: resourceActions });
            if (signal?.aborted) throw new Error('Jev-cu cancelled');
            if (!supportedActions.has(decision.action)) throw new Error(`unsupported action: ${decision.action}`);
            if (['set_value', 'type_text'].includes(decision.action) && params.resources?.text === undefined) {
              throw new Error('resources.text is required');
            }
            if (decision.action === 'press_key' && !params.resources?.key) throw new Error('resources.key is required');
            if (decision.targetIndex != null) driver.selectTarget(decision.targetIndex);
            return decision;
          },
        });
        const isError = result.status !== 'dry_run' && !(result.status === 'done' && result.verified === true);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result, isError };
      } finally {
        activeWindows.delete(windowKey);
      }
    },
  };
}

export default function jevCu(api) {
  api.registerTool(createJevTool());
}
