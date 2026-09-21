import test from "node:test";
import assert from "node:assert/strict";
import { parseAX, selectCandidates, buildContext } from "../scripts/loop.mjs";
import { evaluatePolicy, matchSensitive } from "../scripts/policy.mjs";
import { buildQuestions, normalizeDecision, sanitizeLabel } from "../scripts/jev-decide.mjs";

const CALENDAR_AX = [
  'Window: "Calendar", App: Calendar.',
  '0 standard window Calendar, ID: CALMainWindow, Secondary Actions: Raise',
  "\t1 split group",
  "\t\t2 container Description: Month Calendar Area, Value: 9/18/26, ID: active-view",
  "\t\t\t4 list Sunday, August 30",
  "\t\t\t5 list Monday, August 31",
  "\t\t\t6 list Tuesday, September 1",
  "\t\t\t7 list Wednesday, September 2",
  "\t\t\t8 list Thursday, September 3",
  "\t\t\t9 list Friday, September 4",
  "\t\t\t10 list Saturday, September 5",
  "\t\t\t11 list Sunday, September 6",
  "\t\t\t12 list Monday, September 7",
  "\t\t\t13 Event Description: Labor Day. September 7, 2026, All-Day",
  "\t17 list Tuesday, September 8",
  "\t24 list Sunday, September 13",
  "\t31 list Today, Friday, September 18",
  "\t\t\t56 button previous month",
  "\t\t\t57 button Today, ID: today-button",
  "\t\t\t58 button next month",
  "\t\t59 text Value: September 2026, ID: view-date-title",
  "\t60 toolbar",
  "\t\t64 button Description: Add Event",
  "\t\t71 button Search",
  "\t72 close button",
  "The focused UI element is 2 container Description: Month Calendar Area",
].join("\n");

test("parseAX 解析索引/角色/标签", () => {
  const els = parseAX(CALENDAR_AX);
  const prev = els.find((e) => e.index === 56);
  assert.equal(prev.role, "button");
  assert.equal(prev.label, "previous month");
  const field = els.find((e) => e.index === 57);
  assert.equal(field.role, "button");
});

test("selectCandidates 不会把目标按钮挤出候选集（P0 实测回归）", () => {
  const els = parseAX(CALENDAR_AX);
  const candidates = selectCandidates(els, "switch the calendar to the previous month", { max: 40 });
  const indices = candidates.map((c) => c.index);
  assert.ok(indices.includes(56), "previous month 按钮必须在候选集中");
  assert.ok(indices.includes(58), "next month 按钮必须在候选集中");
  // 日历日期格仍可选择；翻月按钮应排在无关日期前。
  assert.ok(indices.indexOf(56) < indices.indexOf(4));
});

test("selectCandidates 在 max 很小时仍优先保留按钮", () => {
  const els = parseAX(CALENDAR_AX);
  const candidates = selectCandidates(els, "previous month", { max: 3 });
  assert.ok(candidates.map((c) => c.index).includes(56));
});

test("selectCandidates 保留单个数字目标用于计算器 shortlist", () => {
  const ax = fs.readFileSync(new URL("../fixtures/ax/calculator.txt", import.meta.url), "utf8");
  const candidates = selectCandidates(parseAX(ax), "click the digit 7 button", { max: 3 });
  assert.ok(candidates.some(candidate => candidate.label.includes("7")), "digit 7 必须进入三个候选");
});

test("buildContext 只取少量上下文", () => {
  const ctx = buildContext(CALENDAR_AX);
  assert.ok(ctx.includes("Calendar"));
  assert.ok(ctx.includes("September 2026"), "应包含关键文本状态（当前月份）");
  assert.ok(ctx.split("\n").length <= 9);
});

test("buildContext 带上计算器显示值", () => {
  const calcAx = ['Window: "Calculator", App: Calculator.', '0 standard window Calculator', '\t4 text ‎42', '\t24 button Equals'].join("\n");
  const ctx = buildContext(calcAx);
  assert.ok(ctx.includes("42"), "Jev 必须能看到当前显示值");
});

test("policy：完成概率高 → done", () => {
  const gate = evaluatePolicy({ decision: { done: 0.95, confidence: 1, targetIndex: 56 }, app: "Calendar" });
  assert.equal(gate.verdict, "done");
});

test("policy：敏感目标 → confirm", () => {
  const gate = evaluatePolicy({
    decision: { done: 0.01, risk: 0.01, confidence: 0.99, targetIndex: 12, targetLabel: "button 删除歌曲" },
    app: "NetEaseMusic",
  });
  assert.equal(gate.verdict, "confirm");
});

test("policy：高风险判定 → confirm", () => {
  const gate = evaluatePolicy({
    decision: { done: 0.01, risk: 0.8, confidence: 0.99, targetIndex: 12, targetLabel: "button download" },
    app: "NetEaseMusic",
  });
  assert.equal(gate.verdict, "confirm");
});

test("policy：低置信度分级 stop / escalate", () => {
  const stop = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.2, targetIndex: 1 }, app: "Calendar" });
  assert.equal(stop.verdict, "stop");
  // Calendar 属零副作用 App（下限 0.4），0.35 仍应升级
  const esc = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.35, targetIndex: 1 }, app: "Calendar" });
  assert.equal(esc.verdict, "escalate");
  // 非零副作用 App（下限 0.5），0.45 应升级
  const esc2 = evaluatePolicy({ decision: { done: 0.1, risk: 0.01, confidence: 0.45, targetIndex: 1 }, app: "NetEaseMusic" });
  assert.equal(esc2.verdict, "escalate");
});

test("policy：零副作用 App 置信度 0.46 放行，其他 App 仍升级", () => {
  const calc = evaluatePolicy({ decision: { done: 0.1, risk: 0.03, confidence: 0.46, targetIndex: 24, targetLabel: "button: Equals" }, app: "Calculator" });
  assert.equal(calc.verdict, "proceed");
  const netease = evaluatePolicy({ decision: { done: 0.1, risk: 0.03, confidence: 0.46, targetIndex: 24, targetLabel: "link: 播放" }, app: "NetEaseMusic" });
  assert.equal(netease.verdict, "escalate");
});

test("policy：白名单外的 App → confirm", () => {
  const gate = evaluatePolicy({ decision: { done: 0.1, risk: 0, confidence: 1, targetIndex: 1 }, app: "UnknownApp" });
  assert.equal(gate.verdict, "confirm");
});

test("matchSensitive 命中支付与发送", () => {
  assert.equal(matchSensitive("button 立即支付").id, "payment");
  assert.equal(matchSensitive("button Send message").id, "send");
  assert.equal(matchSensitive("button Search"), null);
});

test("buildQuestions/normalizeDecision 往返一致", () => {
  const candidates = [
    { index: 56, role: "button", label: "previous month" },
    { index: 58, role: "button", label: "next month" },
  ];
  const { questions, criteria } = buildQuestions("go to the previous month", candidates);
  assert.ok(questions.target.criteria.i56.includes("previous month"));
  assert.ok(questions.action.criteria.drag, "动作类型应包含 drag");
  const decision = normalizeDecision(
    {
      target: { choice: "i56", confidence: 1, probabilities: { i56: 1, i58: 0 } },
      action: { choice: "click_element" },
      done: { noul: 0.04 },
      risk: { noul: 0.01 },
    },
    criteria,
  );
  assert.equal(decision.targetIndex, 56);
  assert.equal(decision.action, "click_element");
  assert.equal(decision.done, 0.04);
});

test("sanitizeLabel 去掉长 URL 并限长", () => {
  const raw = "link: 下载管理, Value: orpheus://orpheus/pub/app.html?resizable=true&x=0&y=0&width=1470#/m/offline/complete/";
  const clean = sanitizeLabel(raw);
  assert.ok(!clean.includes("orpheus://"));
  assert.ok(clean.includes("下载管理"));
  assert.ok(clean.length <= 120);
});

// 执行边界回归：全部使用模拟 driver，不操作真实 App、不调用网络。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runTask } from "../scripts/loop.mjs";

async function mockRun(options) {
  const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-test-"));
  try {
    return await runTask({ appName: "Calendar", goal: "next month", emit: () => {}, traceDir, ...options });
  } finally {
    fs.rmSync(traceDir, { recursive: true, force: true });
  }
}

test("Planner 预览无动作，真实执行交给接管", async () => {
  let actions = 0;
  const driver = { bind: async () => {}, observe: async () => CALENDAR_AX, typeText: async () => { actions++; } };
  for (const dryRun of [true, false]) {
    const result = await mockRun({ driver, dryRun, maxSteps: 1, resources: () => ({ skipJev: true, action: "type_text", text: "test" }) });
    assert.equal(result.status, dryRun ? "dry_run" : "escalate");
  }
  assert.equal(actions, 0);
});

test("完成以最终状态核验，最后一步之后也检查", async () => {
  let ax = CALENDAR_AX;
  const observations = [];
  const driver = {
    bind: async () => {},
    observe: async ({ full }) => { observations.push(full); return ax; },
    click: async () => { ax = ax.replace("September 2026", "October 2026"); },
  };
  const result = await mockRun({ driver, dryRun: false, maxSteps: 1,
    decide: async () => ({ action: "click_element", targetIndex: 58, targetLabel: "next month", confidence: 1, risk: 0, done: 0 }),
    verify: text => text.includes("October 2026"),
  });
  assert.equal(result.status, "done");
  assert.equal(result.verified, true);
  assert.deepEqual(observations, [true, true]);
});

test("Jev 自报完成不能覆盖失败的结果核验", async () => {
  const result = await mockRun({ driver: { bind: async () => {}, observe: async () => CALENDAR_AX },
    dryRun: false, maxSteps: 1, verify: () => false,
    decide: async () => ({ done: 0.99, confidence: 1 }),
  });
  assert.equal(result.status, "escalate");
});

test("未知目标和缺失概率不放行", () => {
  const decision = normalizeDecision({ target: { choice: "i999" }, action: { choice: "click_element" } }, { i1: "button A" });
  assert.equal(decision.targetIndex, null);
  assert.equal(evaluatePolicy({ decision, app: "Calendar" }).verdict, "escalate");
});

const NEXT_MONTH = { action: "click_element", targetIndex: 58, targetLabel: "next month", confidence: 1, risk: 0, done: 0 };

test("click_element 使用策略批准的索引，不受 resources.at 覆盖", async () => {
  const clicks = [];
  await mockRun({
    driver: { bind: async () => {}, observe: async () => CALENDAR_AX, click: async (...args) => { clicks.push(args); } },
    dryRun: false, maxSteps: 1, decide: async () => NEXT_MONTH,
    resources: { at: [999, 999], mouseButton: "right" },
  });
  assert.deepEqual(clicks, [[58, { mouseButton: "right" }]]);
});

for (const scenario of [
  { name: "连续两次无变化即停止", decisions: [NEXT_MONTH, NEXT_MONTH], steps: 2 },
  { name: "目标变化重置连续次数", decisions: [NEXT_MONTH, { ...NEXT_MONTH, targetIndex: 56 }, NEXT_MONTH, NEXT_MONTH], steps: 4 },
  { name: "动作变化重置连续次数", decisions: [NEXT_MONTH, { ...NEXT_MONTH, action: "press_key" }, NEXT_MONTH, NEXT_MONTH], steps: 4 },
  { name: "界面变化重置连续次数", decisions: [NEXT_MONTH], changeAt: 2, steps: 4 },
  { name: "交替目标不累计无效次数", decisions: [NEXT_MONTH, { ...NEXT_MONTH, targetIndex: 56 }, NEXT_MONTH, { ...NEXT_MONTH, targetIndex: 56 }], steps: 4, maxSteps: 4, status: "max_steps" },
]) {
  test(`无效动作：${scenario.name}`, async () => {
    let actions = 0;
    let decisions = 0;
    let ax = CALENDAR_AX;
    const act = async () => {
      actions++;
      if (actions === scenario.changeAt) ax = ax.replace("September 2026", "October 2026");
    };
    const result = await mockRun({
      driver: { bind: async () => {}, observe: async () => ax, click: act, pressKey: act },
      dryRun: false, maxSteps: scenario.maxSteps ?? 6, verify: () => false,
      decide: async () => scenario.decisions[Math.min(decisions++, scenario.decisions.length - 1)],
    });
    assert.equal(actions, scenario.steps);
    assert.equal(decisions, scenario.steps);
    assert.equal(result.steps, scenario.steps);
    assert.equal(result.status, scenario.status ?? "stop");
  });
}

test("实际核验成功优先于第二次无变化的停止", async () => {
  for (const maxSteps of [2, 5]) {
    let clicks = 0;
    const result = await mockRun({
      driver: { bind: async () => {}, observe: async () => CALENDAR_AX, click: async () => { clicks++; } },
      dryRun: false, maxSteps, decide: async () => NEXT_MONTH,
      verify: async () => clicks === 2,
    });
    assert.equal(clicks, 2);
    assert.equal(result.steps, 2);
    assert.equal(result.status, "done");
    assert.equal(result.verified, true);
  }
});

for (const scenario of [
  { name: "缺少密钥", index: null, accuracy: "0/1", status: 1 },
  { name: "选择错误", index: 58, accuracy: "0/1", status: 1 },
  { name: "全部命中", index: 56, accuracy: "1/1", status: 0 },
]) {
  test(`P0 退出码：${scenario.name}`, () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "jev-p0-test-"));
    try {
      fs.mkdirSync(path.join(repo, "scripts"));
      for (const file of ["p0-eval.mjs", "loop.mjs", "jev-decide.mjs", "qwen-decide.mjs", "laya-decide.mjs", "policy.mjs"]) {
        fs.copyFileSync(new URL(`../scripts/${file}`, import.meta.url), path.join(repo, "scripts", file));
      }
      fs.cpSync(new URL("../fixtures/", import.meta.url), path.join(repo, "fixtures"), { recursive: true });
      // 不继承环境或复制 .env.local；fetch 只返回固定响应，绝不访问网络。
      const bootstrap = `
        globalThis.fetch = async () => {
          if (${scenario.index === null}) throw new Error("测试禁止网络请求");
          return { ok: true, json: async () => ({ answers: {
            target: { choice: "i${scenario.index}", confidence: 1 },
            action: { choice: "click_element" }, done: { noul: 0 }, risk: { noul: 0 }
          } }) };
        };
        process.argv = [process.execPath, "scripts/p0-eval.mjs", "--limit", "1"];
        await import("./scripts/p0-eval.mjs");
      `;
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", bootstrap], {
        cwd: repo, env: scenario.index === null ? {} : { TYPESAFE_API_KEY: "test-only" },
        encoding: "utf8", timeout: 10_000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.stderr, "");
      const reports = fs.readdirSync(path.join(repo, "runs"));
      assert.equal(reports.length, 1);
      const report = JSON.parse(fs.readFileSync(path.join(repo, "runs", reports[0]), "utf8"));
      assert.equal(report.accuracy, scenario.accuracy);
      assert.equal(report.rows.length, 1);
      if (scenario.index === null) assert.match(report.rows[0].got, /ERR .*TYPESAFE_API_KEY/);
      assert.equal(result.status, scenario.status, result.stdout);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
}
