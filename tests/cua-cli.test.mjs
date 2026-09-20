import test from "node:test";
import assert from "node:assert/strict";
import { createCliDriver } from "../scripts/cua-cli.mjs";
import { parseAX, buildContext } from "../scripts/loop.mjs";

const target = { pid: 123, window_id: 456, session: "adapter-test" };
const state = (snapshotId = "s00000001") => ({
  pid: 123, window_id: 456, snapshot_id: snapshotId, elements_complete: true,
  tree_markdown: '[999] AXButton "不得解析此 Markdown"',
  elements: [
    { element_index: 0, role: "AXWindow", label: "计算器", depth: 0 },
    { element_index: 7, role: "AXButton", label: "7", depth: 2, parent_index: 0 },
    { element_index: 11, role: "AXStaticText", label: "结果", value: "42", depth: 1 },
    { element_index: 19, role: "AXTextArea", label: "正文", value: "第一行\n第二行", depth: 1 },
    { element_index: 22, role: "AXTextField", label: "输入", value: "", depth: 1 },
    { element_index: 30, role: "AXScrollArea", label: "文档", depth: 1 },
    { element_index: 40, role: "AXMenuBar", depth: 0 },
    { element_index: 41, role: "AXMenuItem", label: "新建", parent_index: 40, depth: 1 },
  ].map(e => ({ ...e, element_token: `${snapshotId}:${e.element_index}` })),
});

function fixture(override) {
  const calls = [];
  const controller = new AbortController();
  const invoke = async (name, args, options) => {
    calls.push({ name, args, options });
    if (override) {
      const result = await override(name, args, options);
      if (result !== undefined) return result;
    }
    if (name === "list_apps") return { apps: [{ pid: 123, running: true, name: "计算器", bundle_id: "com.apple.calculator" }] };
    if (name === "list_windows") return { windows: [{ pid: 123, window_id: 456, title: "计算器" }] };
    if (name === "get_window_state") return state();
    return { success: true };
  };
  return {
    calls, controller,
    driver: createCliDriver({ pid: 123, windowId: 456, session: "adapter-test", signal: controller.signal, invoke }),
  };
}

test("绑定只核验指定 PID、窗口和允许的 bundle，不启动或激活应用", async () => {
  const { driver, calls, controller } = fixture();
  assert.deepEqual(await driver.bind("Calculator"), {
    pid: 123, windowId: 456, appName: "Calculator", bundleId: "com.apple.calculator",
  });
  assert.deepEqual(calls.map(({ name, args }) => ({ name, args })), [
    { name: "list_apps", args: {} }, { name: "list_windows", args: { pid: 123 } },
  ]);
  for (const { options } of calls) {
    assert.equal(options.signal, controller.signal);
    assert.equal(options.timeout, 30_000);
    assert.equal(options.maxBuffer, 8 * 1024 * 1024);
  }
});

test("缺失目标、禁止应用、错误身份或错误窗口均拒绝", async () => {
  for (const options of [{}, { pid: 123 }, { pid: "123", windowId: 456 }, { pid: 123, windowId: -1 }]) {
    assert.throws(() => createCliDriver(options), /pid|windowId/);
  }
  const { driver, calls } = fixture();
  await assert.rejects(driver.bind("Safari"), /allowed|支持/);
  await assert.rejects(driver.bind("constructor"), /allowed|支持/);
  assert.equal(calls.length, 0);
  await assert.rejects(driver.observe(), /bind|绑定/);
  for (const badApp of [
    { pid: 123, running: true, bundle_id: "com.apple.TextEdit" },
    { pid: 999, running: true, bundle_id: "com.apple.calculator" },
    { pid: 123, running: false, bundle_id: "com.apple.calculator" },
  ]) {
    const f = fixture(name => name === "list_apps" ? { apps: [badApp] } : undefined);
    await assert.rejects(f.driver.bind("Calculator"), /identity|身份/);
  }
  const f = fixture(name => name === "list_windows" ? { windows: [{ pid: 999, window_id: 456 }] } : undefined);
  await assert.rejects(f.driver.bind("Calculator"), /window|窗口/);
});

test("结构化元素转换为上游 AX，保留索引和字段值，不泄露 token", async () => {
  const { driver, calls } = fixture();
  await driver.bind("Calculator");
  const ax = await driver.observe({ full: true });
  const elements = parseAX(ax);
  assert.equal(elements.find(e => e.index === 7).role, "button");
  assert.equal(elements.find(e => e.index === 11).role, "text");
  assert.equal(elements.find(e => e.index === 19).role, "text field");
  assert.equal(elements.find(e => e.index === 22).role, "text field");
  assert.equal(elements.find(e => e.index === 30).role, "scroll area");
  assert.match(buildContext(ax), /42/);
  assert.equal(elements.length, state().elements.length);
  assert.doesNotMatch(ax, /999|s00000001|element_token|snapshot_id/);
  assert.deepEqual(calls.at(-1).args, { ...target, include_screenshot: false });
  const snapshot = driver.getSnapshot();
  assert.equal(snapshot.elements.find(e => e.element_index === 19).value, "第一行\n第二行");
  assert.equal(snapshot.elements.find(e => e.element_index === 11).role, "AXStaticText");
  assert.equal(snapshot.elements.find(e => e.element_index === 11).normalizedRole, "text");
  assert.doesNotMatch(JSON.stringify(snapshot), /s00000001|element_token|snapshot_id|tree_markdown/);
  snapshot.elements[0].label = "改写副本";
  assert.equal(driver.getSnapshot().elements[0].label, "计算器");
});

test("CLI 的 structuredContent 包装也读取结构化字段", async () => {
  const { driver } = fixture(name => name === "get_window_state" ? { structuredContent: state() } : undefined);
  await driver.bind("Calculator");
  assert.match(await driver.observe(), /7 button 7/);
});

test("未索引的计算器静态值进入只读结果，不成为可点击候选", async () => {
  const native = state();
  native.elements = native.elements.filter(e => e.role !== "AXStaticText");
  native.tree_markdown = '- [0] AXWindow "Calculator"\n    - AXStaticText = "6×7"\n    - AXStaticText = "42"\n- [40] AXMenuBar\n    - AXStaticText = "not a result"';
  const { driver } = fixture(name => name === "get_window_state" ? native : undefined);
  await driver.bind("Calculator");
  const ax = await driver.observe();
  assert.match(buildContext(ax), /42/);
  const values = driver.getSnapshot().elements.filter(e => e.role === "AXStaticText");
  assert.deepEqual(values.map(e => e.value), ["6×7", "42"]);
  assert.ok(values.every(e => e.readOnly && e.element_index === undefined));
  assert.throws(() => driver.selectTarget(42), /index|索引/);
});

for (const [method, index, parameters, toolName, fields] of [
  ["click", 7, [7], "click", { delivery_mode: "background" }],
  ["setValue", 19, [19, 'a";$(echo unsafe)\nb'], "set_value", { value: 'a";$(echo unsafe)\nb' }],
  ["typeText", 19, ["文字"], "type_text", { text: "文字", delivery_mode: "background" }],
  ["pressKey", 19, ["Return"], "press_key", { key: "return", delivery_mode: "background" }],
  ["scroll", 30, [30, "down", 2], "scroll", { direction: "down", amount: 2, by: "page", delivery_mode: "background" }],
]) {
  test(`${method} 派发精确 token 后消耗快照，重新 observe 才能继续`, async () => {
    const { driver, calls } = fixture();
    await driver.bind("Calculator");
    await driver.observe();
    driver.selectTarget(index);
    await driver[method](...parameters);
    assert.equal(calls.at(-1).name, toolName);
    assert.deepEqual(calls.at(-1).args, { ...target, element_token: `s00000001:${index}`, ...fields });
    assert.equal(driver.getSnapshot(), null);
    const count = calls.length;
    await assert.rejects(driver[method](...parameters), /observe|快照/);
    assert.equal(calls.length, count);
    await driver.observe();
    driver.selectTarget(index);
    await driver[method](...parameters);
    assert.deepEqual(calls.slice(2).map(c => c.name), ["get_window_state", toolName, "get_window_state", toolName]);
  });
}

test("键盘输入必须选中当前快照目标，重新 observe 清除旧选择", async () => {
  let n = 0;
  const { driver, calls } = fixture(name => name === "get_window_state" ? state(`s0000000${++n}`) : undefined);
  await driver.bind("Calculator");
  await driver.observe();
  await assert.rejects(driver.typeText("x"), /selectTarget|目标/);
  assert.throws(() => driver.selectTarget(999), /index|索引/);
  driver.selectTarget(19);
  await driver.observe();
  await assert.rejects(driver.pressKey("Return"), /selectTarget|目标/);
  driver.selectTarget(22);
  await driver.typeText("x");
  assert.equal(calls.at(-1).args.element_token, "s00000002:22");
});

test("坐标、拖动、前台/像素选项和菜单栏动作不回退", async () => {
  const { driver, calls } = fixture();
  await driver.bind("Calculator");
  await driver.observe();
  const count = calls.length;
  await assert.rejects(driver.click([10, 20]), /coordinate|坐标/);
  await assert.rejects(driver.drag([0, 0], [1, 1]), /drag|拖动/);
  await assert.rejects(driver.click(7, { mouseButton: "middle" }), /unsupported|支持/);
  await assert.rejects(driver.click(7, { delivery_mode: "foreground" }), /unsupported|支持/);
  await assert.rejects(driver.click(41), /menu|菜单/);
  await assert.rejects(driver.scroll(30, "diagonal", 1), /direction|方向/);
  await assert.rejects(driver.scroll(30, "down", 0), /amount|数量/);
  assert.equal(calls.length, count);
});

test("派发失败也使快照失效，结构化错误不会伪装成成功", async () => {
  for (const failure of [
    { isError: true, content: [{ type: "text", text: "accessibility denied" }] },
    { error: { code: "stale_snapshot", message: "snapshot expired" } },
    { structuredContent: { error: { code: "permission_denied", message: "permission denied" } } },
    { success: false, message: "native action failed" },
  ]) {
    const { driver, calls } = fixture(name => name === "click" ? failure : undefined);
    await driver.bind("Calculator");
    await driver.observe();
    await assert.rejects(driver.click(7), /denied|expired|failed/);
    assert.equal(driver.getSnapshot(), null);
    const count = calls.length;
    await assert.rejects(driver.click(7), /observe|快照/);
    assert.equal(calls.length, count);
  }
});

test("错误或无结构化数据的观测不保留上一快照", async () => {
  for (const broken of [
    { tree_markdown: "[7] AXButton 7" },
    { ...state(), pid: 999 },
    { ...state(), window_id: 999 },
    { ...state(), snapshot_id: undefined },
    { ...state(), elements: [{ element_index: 7, role: "AXButton" }] },
    { ...state(), elements: [...state().elements, state().elements[0]] },
  ]) {
    let reads = 0;
    const { driver } = fixture(name => name === "get_window_state" ? (++reads === 1 ? state() : broken) : undefined);
    await driver.bind("Calculator");
    await driver.observe();
    await assert.rejects(driver.observe(), /snapshot|快照|identity|身份|elements|元素/);
    assert.equal(driver.getSnapshot(), null);
    await assert.rejects(driver.click(7), /observe|快照/);
  }
});

test("AbortSignal 已取消时不派发，在途调用接收同一个取消信号", async () => {
  const a = fixture();
  a.controller.abort();
  await assert.rejects(a.driver.bind("Calculator"), { name: "AbortError" });
  assert.equal(a.calls.length, 0);
  const entered = Promise.withResolvers();
  const b = fixture((name, args, { signal }) => {
    if (name !== "click") return undefined;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      entered.resolve();
    });
  });
  await b.driver.bind("Calculator");
  await b.driver.observe();
  const action = b.driver.click(7);
  await entered.promise;
  b.controller.abort();
  await assert.rejects(action, { name: "AbortError" });
  assert.equal(b.driver.getSnapshot(), null);
});

test("未完成的观察禁止并发调用，不能用旧 token 穿越观察", async () => {
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  const { driver } = fixture(name => {
    if (name !== "get_window_state") return undefined;
    started.resolve();
    return response.promise;
  });
  await driver.bind("Calculator");
  const observation = driver.observe();
  await started.promise;
  await assert.rejects(driver.observe(), /progress|进行/);
  await assert.rejects(driver.click(7), /progress|进行/);
  response.resolve(state());
  await observation;
  await driver.click(7);
});
