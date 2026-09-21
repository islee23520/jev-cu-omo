#!/usr/bin/env node
/**
 * P0 离线评测：用保存的 AX 快照 + 标注的期望元素，测 Jev 的元素选择准确率。
 *
 * 用例文件 fixtures/p0/cases.json：
 *   [{ "name": "...", "app": "Calendar", "goal": "...", "axFile": "fixtures/ax/calendar-month.txt",
 *      "expectedIndex": 56, "expectedLabelIncludes": "previous month" }]
 *
 * 用法：
 *   node scripts/p0-eval.mjs            # 跑全部用例
 *   node scripts/p0-eval.mjs --limit 3  # 只跑前 3 条
 *   node scripts/p0-eval.mjs --local   # 用自托管 Qwen（JEV_CU_QWEN_URL，默认 127.0.0.1:11435）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAX, selectCandidates, buildContext } from "./loop.mjs";
import { decide } from "./jev-decide.mjs";
import { decideLocal } from "./qwen-decide.mjs";
import { decideLaya, shutdownLayaWorkers } from "./laya-decide.mjs";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CASES_PATH = path.join(PROJECT_DIR, "fixtures", "p0", "cases.json");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
const candidateMaxArg = process.argv.indexOf("--candidate-max");
const candidateMax = candidateMaxArg > -1 ? Number(process.argv[candidateMaxArg + 1]) : null;
const useLocal = process.argv.includes("--local");
const useLaya = process.argv.includes("--laya");
const decideFn = useLaya ? decideLaya : useLocal ? decideLocal : decide;

const cases = JSON.parse(fs.readFileSync(CASES_PATH, "utf8")).slice(0, limit);
if (!cases.length) {
  console.error("没有用例：请先填写 fixtures/p0/cases.json");
  process.exit(1);
}

const rows = [];
for (const c of cases) {
  const axPath = path.join(PROJECT_DIR, c.axFile);
  const ax = fs.readFileSync(axPath, "utf8");
  const candidates = selectCandidates(parseAX(ax), c.goal, { max: candidateMax ?? c.max ?? 40 });
  let decision;
  let error = null;
  try {
    decision = await decideFn({
      goal: c.goal,
      app: c.app,
      candidates,
      context: buildContext(ax),
      constraints: c.constraints ?? "",
    });
  } catch (err) {
    error = err.message;
  }

  const hit =
    !error &&
    (c.expectedIndex != null
      ? decision.targetIndex === c.expectedIndex
      : String(decision.targetLabel ?? "").includes(c.expectedLabelIncludes ?? "\u0000"));

  rows.push({
    name: c.name,
    expected: c.expectedIndex ?? c.expectedLabelIncludes ?? "?",
    got: error ? `ERR ${error}` : `i${decision.targetIndex} ${decision.targetLabel ?? ""}`,
    hit,
    conf: decision?.confidence ?? null,
    ms: decision?.latencyMs ?? null,
    tokens: decision?.usage?.input_tokens ?? decision?.usage?.inputTokens ?? null,
    cost: decision?.costUsd ?? null,
    candidates: candidates.length,
  });
  console.log(
    `${hit ? "✅" : "❌"} ${c.name.padEnd(28)} 期望=${String(rows.at(-1).expected).padEnd(18)} 得到=${rows.at(-1).got}` +
      (error ? "" : `  conf=${rows.at(-1).conf?.toFixed?.(2) ?? "n/a"} ${rows.at(-1).ms}ms ${rows.at(-1).tokens}tok`),
  );
}

const ok = rows.filter((r) => r.hit);
const lat = rows.map((r) => r.ms).filter((n) => typeof n === "number").sort((a, b) => a - b);
const tokens = rows.reduce((a, r) => a + (r.tokens ?? 0), 0);
const cost = rows.reduce((a, r) => a + (r.cost ?? 0), 0);
const p50 = lat.length ? lat[Math.floor(lat.length / 2)] : null;

console.log(
  `\n准确率 ${ok.length}/${rows.length}` +
    ` · p50 ${p50 ?? "n/a"}ms` +
    ` · tokens ${tokens}` +
    ` · 成本 ≈ $${cost.toFixed(6)}`,
);

const reportDir = path.join(PROJECT_DIR, "runs");
fs.mkdirSync(reportDir, { recursive: true });
const reportPath = path.join(reportDir, `p0-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), accuracy: `${ok.length}/${rows.length}`, p50Ms: p50, tokens, costUsd: cost, rows }, null, 2));
console.log(`报告：${reportPath}`);
if (useLaya) shutdownLayaWorkers();
process.exitCode = ok.length === rows.length ? 0 : 1;
