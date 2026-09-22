# jev-cu-omo

Verified native macOS computer use for OmO with typed decisions and cua-driver.
Dependency-free Node.js (ESM, `node:test`); Python helpers live under `scripts/`
as independent worker processes with their own environments.

## Repository workflow

Before changing this repository:

- Read this file and `server/README.md` first.
- Run `git fetch --all --prune`, then report the current branch, upstream,
  worktree status, and the target branch before editing. Feature work lives on
  clearly named non-target branches; push to the branch's configured upstream
  after verification.
- One atomic commit per verified change; never include unrelated dirty files,
  `.env` files, secrets, or private run artifacts.

## Commands

```bash
npm test                      # node --test tests/*.test.mjs (all contract tests)
node --test tests/qwen-image.test.mjs   # focused image-service contract tests
npm run qwen-image -- health  # CLI client for the Windows qwen-image service
node scripts/jev-decide.mjs   # local Qwen decision adapter
```

- No npm runtime dependencies; use Node built-ins only. Tests inject
  `fetchImpl`/drivers instead of network or mock frameworks.
- New server-side features ship with a `tests/*.test.mjs` contract test.

## Structure

- `extension/jev-cu.mjs` — OmO extension tool surface
- `scripts/` — decision adapters (`qwen-decide.mjs`, `laya-decide.mjs`), CLI
  drivers, and the `qwen-image.mjs` client for the Windows image service
- `tests/` — node:test suites (no network)
- `server/` — Windows Docker Compose deployment for `desktop-bo514et`
  (`E:\git\jev-cu-qwen`), see `server/README.md`
- `skill/`, `fixtures/`, `docs/` — skill packaging and evaluation data

## Windows server contract (`E:\git\jev-cu-qwen`)

- The existing `ollama` service (pinned `ollama/ollama:0.32.11` digest, host
  loopback `QWEN_PORT` → 11435, `./docker-data` bind, native rollback models
  under `E:\git\jev-cu-qwen\models`) must never be altered by feature work.
- The `qwen-image` service is an opt-in Compose profile: distinct loopback port
  (`QWEN_IMAGE_PORT`, default 11437), its own `./qwen-image-data/{cache,output}`
  binds, NVIDIA GPU reservation, no auto-restart. It runs the official pinned
  Diffusers `QwenImage21Pipeline` (`Qwen/Qwen-Image-2.1`).
- Access the host via `ssh windows` from the Mac. Stage files with
  tar-over-ssh; long builds/downloads run detached with sentinel exit files or
  monitored logs; SSH success alone is never job completion.
