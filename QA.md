# OmO 分支验证记录

日期：2026-09-20。上游基线：`38fb31de7dfe6209bbe6e04057c00c6e885ba577`。
总体结论：本地实现与驱动连接已验证，真实决策模型发布门槛未通过，未生产安装。

## 已完成

| 项目 | 命令或实际入口 | 观测 |
| --- | --- | --- |
| 全部自动测试 | `npm test` | 50 passed，0 failed，exit 0 |
| 语法检查 | `node --check scripts/cua-cli.mjs`、`node --check extension/jev-cu.mjs` | exit 0 |
| diff 检查 | `git diff --check` | exit 0 |
| skill 元数据 | skill-toolkit 的 `quick_validate.py skill/jev-use` | Skill is valid |
| 实际 OmO loader | 安装版本的 `loadExtensions()` | errors 为空，注册 jev_cu |
| 独立 OmO CLI | `node runs/omo-smoke.mjs` | 真实 planner 调用 jev_cu observe 1 次，status observed，isError false |
| 实际 macOS 输入 | cua-driver token 点击独立计算器窗口 | 新 AX 结果为 7，截图确认 |
| 实际扩展循环 | `node runs/native-loop-smoke.mjs` | 3 个注入决定执行 7 × 6，结果 42，verified true |
| 前台保持 | 原生循环前后比较 active app | 均为 VSCode |
| 配置隔离 | 独立 HOME/OMO_CODING_AGENT_DIR/XDG 路径 | 生产 settings/models/omo 配置哈希未变 |

原生循环的决定来自确定性测试注入，**不是 Jev 或其他模型的推理**。
13,684 ms 为这次原生循环总耗时，不能当作模型推理延迟。

## 实机发现并修复

当前 CuaDriver 的结构化 elements 不包含计算器只读结果；同一响应的 AX 文本包含
未索引 AXStaticText。适配器保留结构化元素作动作目标，仅将这些静态值补充到只读
观测和结果核验中，绝不赋予动作 token。新增回归先失败，再通过。

## 未通过的发布门槛

- TypeSafe Google 认证后拒绝："TypeSafe is currently invite-only"。没有 API key，
  真实 Jev P0 准确率、推理耗时、实际 GUI 成功率均未测。用户已确认转用自托管
  公开权重模型作为本地决策后端（不称其为 Jev，不复用 Jev-like）。
- Windows 隔离 Ollama（127.0.0.1:11435，模型库 E:\git\jev-cu-qwen\models）已就绪：
  qwen3:8b 与 qwen3:14b（Q4_K_M）已拉取，Mac 经 ssh -L 隧道访问。
- 本地后端 P0（12 用例，qwen3:8b，temp 0，think false，候选上限 20）：
  - 初版中文提示 0/12；改英文任务提示后 10/12；补 radio Value 语义后 10/12
    （错例：evaluate→数字 2、rankings→发现音乐，各跑两遍均稳定错）。
  - p50 约 0.7 s，输入约 0.5-0.7 k tok/例，成本 0。
  - qwen3:14b 已下载，待 8b GUI 验证后对比。
- 五任务实机验证（qwen3:8b，隔 calculating 实例 pid 49989 / 独立 TextEdit）：
  - 第 1 轮 0/5：驱动选中 30px 幽灵窗口、以及本地模型无校准 confidence 被上游
    策略判 invalid_decision。已修（窗口过滤 + 选中目标时 confidence 填 1.0，
    非校准事实声明于本文件）。
  - 第 2 轮 2/5：7×6、12+30 done verified；9×9 误选 press_key（无 resources.key）、
    8−3 遇 cua-driver 会话结束、TextEdit 连续 type_text 追加。已修（动作枚举按
    resources 收紧、会话先 start_session 复活再重试、set_value/type_text 语义规则）。
  - 第 3 轮 2/5；第 4 轮引入 plan/stepGoals（规划归调用方，决策模型只选元素）后
    4/5；唯一错例是结果显示值的方向标记/千分位差异导致 verify 误判，已加显示值
    归一化。
  - **第 5 轮 5/5 全部 done 且 verified**（`runs/local-qwen-five-tasks.json`）：
    7×6（4 步，67.8s）、9×9（4 步，97.6s）、12+30（6 步，107.2s）、8−3
    （4 步，68.5s）、TextEdit set_value 替换全文（1 步，22.8s）。
  - 前景保持：本轮 before/after 采样为 VSCode→ghostty，系用户本人操作（6 分钟
    窗口内多次自行切换）。驱动侧证据更强：全部动作固定 background 投递并拒绝
    foreground（单元测试锁定），launch 自激活抑制为 true。
- 尚未完成 5 个真实模型驱动 GUI 任务全对，因此不能生产推广。
- 最近一次 CuaDriver LSP 请求超时；此前诊断为空，当前 Node 语法和测试通过（56/56）。

## 证据位置

本地 gitignored `runs/` 保存真实输出，不提交私人 UI 内容或机器路径配置：

- `omo-observe.jsonl`、`omo-observe-summary.json`
- `native-loop-summary.json`、`native-traces/`
- `calculator-before.png`、`calculator-after.png`
- `omo-sandbox/` 独立配置，只连接已有 CuaDriver socket，不修改服务配置

## 8B / 14B benchmark

See [BENCHMARK.md](BENCHMARK.md). Both models produced identical P0 accuracy
(10/12 on all three repeats) and passed the same real macOS GUI suite 5/5.
Qwen3-8B remains the default because it is about 20% faster on P0 and uses
5.58 GB versus 9.65 GB VRAM; 14B's 3.7% GUI wall-time lead is CUA-overhead scale
and came with no decision-quality improvement.

## Jev-like 处置状态

检查过的生产 OmO 两处 extensions 目录与活动配置中未找到 Jev-like 引用，Windows
Docker 容器列表也没有 Jev-like 容器。旧源码目录和 Docker 镜像仍存在，远程
omo-jevlike-router 仓库未归档。不能把“当前无运行路径”称为“已彻底清理”。

当前 fork 代码不依赖 Jev-like。只有完整验收通过后才执行约定的生产替换与清理。

## Windows Docker 后端切换验证（2026-09-20）

目标：Docker Compose 容器接管 `127.0.0.1:11435` 的 `qwen3:8b` 服务，原生专用
进程停止但回滚资源完整保留。独立审计（docker-qwen-migration-gate-review）确认
staging 全部通过但切换未执行；本次按 `server/README.md` 的 cutover 块原样执行并
逐项复核。证据在 gitignored `runs/` 与本地 evidence 目录。

| 项目 | 命令或实际入口 | 观测 |
| --- | --- | --- |
| 切换前身份核验 | `Get-NetTCPConnection -LocalPort 11435` + `Get-Process -Id <server.pid>` | 监听 pid 51800 == `server.pid`，路径为 `%LOCALAPPDATA%\Programs\Ollama\ollama.exe`，无身份不符，继续切换 |
| 停止原生专用进程 | cutover 脚本内 `Stop-Process -Id 51800`（仅该 pid，绝不按进程名全杀） | 复查 pid 51800 ABSENT_OK；预存 11434 原生实例（pid 84436）存活未动 |
| 容器接管 | `.env` 写 `QWEN_PORT=11435` + `docker compose up -d --wait` | `cutover.exit=0`，容器 6.8 s Healthy，`127.0.0.1:11435->11434/tcp` |
| 端口与 GPU 归属 | `netstat -ano`、`docker inspect`、`tasklist` | 11435 owner = `com.docker.backend`(25076)；`HostIp 127.0.0.1` 仅回环；DeviceRequests = nvidia/all/gpu；进程表中仅剩 84436 一个 ollama.exe |
| API 复核 | Mac 隧道 `curl -i /api/tags`、结构化 `/api/chat`、`/api/ps` | HTTP 200；qwen3:8b digest `500a1f067a9f`；结构化 JSON 决策合法；`size_vram` == `size`（100% GPU，5.58 GB） |
| 自动测试 | `npm test` | 58 passed，0 failed，exit 0 |
| P0 基线 | `BENCH_MODELS=qwen3:8b JEV_CU_QWEN_URL=http://127.0.0.1:11435 node runs/benchmark-p0.mjs` | 3 轮均 10/12（与原生基线一致），p50 775 ms |
| GUI 五任务 | `JEV_CU_QA_CALC_PID=4353 JEV_CU_QWEN_URL=http://127.0.0.1:11435 node runs/local-qwen-five-tasks.mjs` | 5/5 done + verified（计算器 4 项 + TextEdit set_value），前台保持 VSCode→VSCode |
| 回滚保留 | `models` 14.5 GB（14b+8b）、`start-ollama.ps1`、`native-start-backup.tar`、`server.pid` | 全部在位；`docker-data` 为 sha256 逐块校验的独立副本（5.2 GB）；未删除任何数据 |

镜像 `ollama/ollama:0.32.11@sha256:acc1d61dc30525ecbe11c811462637f474ce9b1c8db80321d1cee81e3ffc7894`；
模型卷为 bind mount `E:\git\jev-cu-qwen\docker-data`；容器内 `OLLAMA_HOST=0.0.0.0:11434`
不对外暴露宿主端口。原生 p50 574 ms → 容器 775 ms，决策质量不变。回滚步骤见
`server/README.md`（compose stop、端口回 11436、`start-ollama.ps1` 重启原生）。
