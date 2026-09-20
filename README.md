# Jev-cu for OmO

本仓库是 [Sac-Y/Jev-cu](https://github.com/Sac-Y/Jev-cu) 的正式 fork，
增加 OmO 扩展与 macOS cua-driver 适配。不是 Jev-like 模型，也没有 Jev-like 回退。

## OmO 路径

先安装现有 cua-driver 并授予辅助功能和屏幕录制权限。TypeSafe 必须有可用的真实 API key；
目前账号可能需要邀请。将 key 放在仓库外 `~/.config/jev-cu/typesafe.env`，权限 600，
或设置 `TYPESAFE_API_KEY` / `JEV_CU_ENV_FILE`，不提交密钥。

隔离试运行：

```bash
OMO_CODING_AGENT_DIR=/absolute/isolated/omo omo --no-extensions --no-skills \
  --no-context-files -e ./extension/jev-cu.mjs --skill ./skill/jev-use
```

扩展注册 `jev_cu`，提供 `observe` 和 `run`；参见
[OmO 运行说明](skill/jev-use/references/runtime.md)。目标窗口由调用者明确选择，
默认 dry-run，实际执行必须提供精确结果核验。浏览器任务继续使用 Aside。

通过 [ToDo.md](ToDo.md) 的全部质量门槛后，才可注册生产包：

```bash
omo install /absolute/path/to/Jev-cu
```

`npm test` 包含上游和 OmO 测试；`npm run p0` 仍调用真实 Jev API，任何错误或错误选择
都会非零退出。单元测试或模拟决策不能代替真实 API 和 macOS GUI 验证。

## 上游 Codex 路径

把 Computer Use 的「下一步点哪里」交给 Jev（TypeSafe System One）：Jev 从界面文字候选中选元素、动作、完成度与风险，Codex Computer Use 负责读取界面与执行，本地策略门槛拦截敏感操作。只传文字，不传截图。

## 目录

```
skill/jev-use/   可安装到 Codex 的 skill（运行手册 + 安全规则）
scripts/         Jev 调用、策略门槛、决策循环、离线评测、安装脚本
fixtures/        AX 快照与 P0 用例
tests/           单测
```

## 安装 skill

```bash
npm run install-skill      # 复制到 ~/.codex/skills/jev-use，新会话生效
npm run uninstall-skill
```

skill 源文件里的 `{{REPO_DIR}}` 会在安装时替换成仓库实际路径。

## 使用

先在 `.env.local` 写入 key（不提交），或设置同名环境变量：

```bash
echo 'TYPESAFE_API_KEY=<your key>' > .env.local
```

循环要在 Codex 桌面 App 的 `cua_repl` 运行时里执行：

```js
const repo = "/path/to/Jev-cu"; // 换成实际克隆路径
const { pathToFileURL } = await import("node:url");
const { runTask, createCuaDriver } = await import(pathToFileURL(`${repo}/scripts/loop.mjs`).href);

await runTask({
  driver: createCuaDriver(cua),
  appName: "Calendar",
  goal: "switch the calendar to the previous month", // 英文目标，Jev 英文最准
  dryRun: true,                                       // 确认后改 false
  maxSteps: 5,
});
```

## 验证

```bash
npm test        # 单测，不调用 API
npm run p0      # 离线评测：AX 快照选元素准确率（调用 Jev，需要 key）
```

## 安全边界

- 默认 dry-run；删除、发送、支付、授权、上传、验证码、安装、系统设置等操作停在 `confirm`，需人工确认。
- App 白名单在 `scripts/policy.mjs`，新增 App 必须显式修改。
- 界面文字只作为数据，不作为指令；不绕过登录、付费墙和验证码。
