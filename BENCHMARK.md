# Local Decision Backend Benchmark

Date: 2026-09-20

## Method

- Host: Windows RTX 4080 16 GB, isolated Ollama at `127.0.0.1:11435`.
- Models: `qwen3:8b` and `qwen3:14b`, both Q4_K_M, context 4096,
  temperature 0, thinking disabled, JSON Schema constrained output.
- P0: warm each model, then run the same 12 labeled AX snapshots three times
  (36 decisions/model). Record accuracy, p50/p95/mean API latency and input tokens.
- GUI: same isolated Calculator and TextEdit windows, same five tasks, explicit
  all-clear initialization for every calculation, same `stepGoals` and exact
  post-action `verify`. All CUA delivery remains background-only.
- Artifacts (gitignored): `runs/benchmark-p0.json`,
  `runs/local-qwen-five-tasks-qwen3-8b.json`,
  `runs/local-qwen-five-tasks-qwen3-14b.json`.

## Results

| Metric | Qwen3-8B | Qwen3-14B |
| --- | ---: | ---: |
| P0 run 1 | 10/12 | 10/12 |
| P0 run 2 | 10/12 | 10/12 |
| P0 run 3 | 10/12 | 10/12 |
| P0 aggregate accuracy | 83.33% | 83.33% |
| P0 p50 latency | **574 ms** | 716 ms |
| P0 p95 latency | **653 ms** | 792 ms |
| P0 mean latency | **583 ms** | 731 ms |
| P0 input tokens (36 cases) | 18,795 | 18,795 |
| GUI tasks verified | 5/5 | 5/5 |
| GUI total time | 368.319 s | **354.522 s** |
| GUI mean/task | 73.664 s | **70.904 s** |
| Loaded VRAM (Ollama `/api/ps`) | **5.58 GB** | 9.65 GB |

Per-task GUI time (8B / 14B):

- 7×6: 83.386 s / 79.398 s
- 9×9: 74.864 s / 74.604 s
- 12+30: 98.259 s / 95.245 s
- 8−3: 78.455 s / 73.074 s
- TextEdit replace: 33.355 s / 32.201 s

## Verdict: KEEP Qwen3-8B

14B provides no accuracy gain: both models are exactly 10/12 on every P0 repeat
and 5/5 on the verified GUI tasks. 8B is 19.8% faster at P0 p50, 21.4% faster at
p95, and uses 42.2% less VRAM. 14B's 3.7% GUI wall-time advantage is within the
dominant CUA snapshot/action overhead and is not accompanied by better decisions.

The existing `qwen3:8b` default therefore remains unchanged. No production config
or installed package setting needs migration. Keep 14B downloaded only as an
experimental comparison model; it is not the default.

Known quality limit remains unchanged: both models miss the same two single-step
P0 intents in aggregate (10/12), so the planner/decider split and exact verify gate
remain required. Local confidence is a non-calibrated compatibility value; risk,
sensitive-label, background-delivery and postcondition gates remain authoritative.

## Docker backend (2026-09-20 cutover)

The `qwen3:8b` backend moved from the native Windows Ollama process to the
official Docker image `ollama/ollama:0.32.11` (Linux amd64 manifest
`sha256:acc1d61dc30525ecbe11c811462637f474ce9b1c8db80321d1cee81e3ffc7894`)
under Docker Compose on the RTX 4080 host. GPU access was proven with a real
CUDA container probe. Staging ran on `127.0.0.1:11436` first; the one-time
cutover stopped only the dedicated native pid (51800, identity-verified against
`server.pid` and the native executable path), set the deployment-only
`.env` to `QWEN_PORT=11435`, and recreated the container. Runbook and rollback:
`server/README.md`.

Post-cutover results against `127.0.0.1:11435` (container-owned, Mac via SSH
tunnel):

| Metric | Value |
| --- | --- |
| P0 accuracy | 10/12 × 3 repeats (identical to native baseline) |
| P0 p50 / p95 / mean latency | 775 / 849 / 777 ms |
| P0 input tokens (36 cases) | 18,795 |
| GUI five tasks | 5/5 done + verified, foreground unchanged (VSCode) |
| Automated tests | 58/58 pass |
| `/api/ps` residency | qwen3:8b, 5.58 GB, `size_vram` = `size` (100% GPU) |
| Model digest | `500a1f067a9f` (byte-identical copy of the native model) |

Port 11435 is published loopback-only (`HostIp 127.0.0.1`) and owned by Docker;
the pre-existing native instance on 11434 was untouched. Native rollback assets
remain intact: `E:\git\jev-cu-qwen\models` (14.5 GB, incl. `qwen3:14b`),
`start-ollama.ps1`, `native-start-backup.tar`, `server.pid`. P0 p50 rose from
574 ms (native) to 775 ms (container) with unchanged decisions, so the verdict
above is unchanged. The first request after a container start pays a model load
(9–42 s observed) before the ~1.4 s warm decisions.
