# OmO 工具调用

先以 cua-driver 获取实际 pid/window_id，再调用 `jev_cu`：

```json
{"operation":"observe","app":"Calculator","pid":123,"windowId":456}
```

以下 pid、windowId、role、label 均为结构示例，不可直接照抄。应从刚才的真实观测
选定显示结果的控件；如果应用的结果在 label 而非 value 中，此判据不适用，停止并检查。

```json
{
  "operation":"run",
  "app":"Calculator",
  "pid":123,
  "windowId":456,
  "goal":"Calculate 6 multiplied by 7.",
  "dryRun":true,
  "maxSteps":8,
  "verify":{"role":"AXStaticText","label":"Result","value":"42"}
}
```

通过预览且已有授权覆盖操作后，改为 `dryRun:false`。结果已达到时直接完成，不重复点击。

- `verify` 是结构化元素的精确 role/value/可选 label 匹配，不执行任意 JavaScript。
- `resources.text` 用于 type_text / set_value，`resources.key` 用于 press_key。
- `resources.direction` 用于 scroll。按键参数不能省略为隐含 Return。
- maxSteps 默认 5、最大 15。每次调用是独立目标，不能把多个阶段伪装成一个已验证结果。
- 每个目标窗口同时只接受一次工具操作，避免快照互相覆盖。
- 每次 Jev 请求超时 20 秒，不自动重试；取消后不得继续执行 GUI 动作。

TypeSafe 账号仍受邀请限制时，只能验证 mock、驱动和 OmO 载入，不能宣称真实 Jev 通过。
