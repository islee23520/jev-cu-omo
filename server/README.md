# Windows Docker Ollama

Docker Compose manages the local Qwen backend on `desktop-bo514et`. This is
process/dependency management, not a claim of VM isolation. No OmO provider or
configuration changes are needed; the final API remains `127.0.0.1:11435`.

- Image: official `ollama/ollama:0.32.11`, pinned to the Linux amd64 manifest
  digest in `compose.yaml` (same version as the native rollback server).
- Compose project/service: `jev-cu-qwen` / `ollama`.
- GPU: NVIDIA device reservation, all GPUs; RTX 4080 on the verified host.
- State: bind mount `E:\git\jev-cu-qwen\docker-data` to `/root/.ollama`.
- Native rollback models: `E:\git\jev-cu-qwen\models`, never mounted in Docker.
- Only the Windows host loopback interface is published. Container-internal
  `OLLAMA_HOST=0.0.0.0:11434` does not expose a LAN host port.
- Compose defaults to staging port **11436**, not the occupied native port.
  After cutover, the deployment-only `.env` sets `QWEN_PORT=11435`.

## Stage without stopping native Ollama

From the Mac repository root, first prove GPU access with a real container:

```bash
ssh windows 'docker run --rm --pull never --gpus all nvidia/cuda:12.8.1-base-ubuntu24.04 nvidia-smi'
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C server compose.yaml stage-docker.ps1 start-ollama.ps1 README.md |
  ssh windows 'tar xf - -C /e/git/jev-cu-qwen'
ssh windows 'powershell -NoProfile -Command '\''Start-Process -FilePath powershell.exe -ArgumentList "-NoProfile -File E:\git\jev-cu-qwen\stage-docker.ps1" -WindowStyle Hidden'\'''
```

Run staging only for initial migration, with native Ollama on 11435. Do not
re-run it on a cut-over deployment: it explicitly selects port 11436. Do not
start concurrent staging jobs. The wrapper is detached from SSH, writes
`docker-stage.log`, and writes `docker-stage.exit` only on completion (0 is
success). Archive an earlier sentinel/log before a new attempt. Inspect the
sentinel, process state and log; SSH success alone is not job completion.

The script copies only the existing `qwen3:8b` manifest and its referenced
content-addressed blobs into a separate Docker store, verifying every SHA256.
It never edits the native source or pulls a different model revision. The copy
uses about 5.23 GB additional disk. No native/container concurrent writes share
a model directory. 14B stays native-only for rollback/experiments.

```bash
ssh windows 'tail -30 /e/git/jev-cu-qwen/docker-stage.log; test ! -f /e/git/jev-cu-qwen/docker-stage.exit || head -1 /e/git/jev-cu-qwen/docker-stage.exit'
ssh windows 'cd /e/git/jev-cu-qwen && docker compose ps && docker compose logs --tail 30'
ssh -fN -o ExitOnForwardFailure=yes -L 127.0.0.1:11436:127.0.0.1:11436 windows
curl -fsS http://127.0.0.1:11436/api/tags
npm test
BENCH_MODELS=qwen3:8b JEV_CU_QWEN_URL=http://127.0.0.1:11436 node runs/benchmark-p0.mjs
JEV_CU_QWEN_MODEL=qwen3:8b JEV_CU_QWEN_URL=http://127.0.0.1:11436 JEV_CU_QA_CALC_PID=<isolated-pid> node runs/local-qwen-five-tasks.mjs
```

The existing `runs/` harnesses and private UI traces are local, gitignored
acceptance artifacts, not shipped runtime dependencies. Use only an isolated
Calculator instance and the established temporary TextEdit probe window.
Record structured `/api/chat` output, `/api/ps` VRAM, model digest, all 58 tests,
P0 **10/12 on each of three repeats** (known baseline, not perfect accuracy),
and all five GUI tasks `done` + exact postcondition `verified`. Keep native
running if any gate fails. The P0 harness itself does not fail its process for
wrong decisions: inspect the result JSON and errors, not just exit status.

## Cutover and rollback

Only after the staging gates pass, run the following in PowerShell on Windows
from `E:\git\jev-cu-qwen`. First verify that `server.pid`, the actual listening
owner and executable all identify the dedicated native server; never stop all
Ollama processes by name. The native launcher and models remain intact.

```powershell
Set-Location E:\git\jev-cu-qwen
$ErrorActionPreference = 'Stop'
$NativeId = [int](Get-Content .\server.pid)
$Listener = Get-NetTCPConnection -LocalPort 11435 -State Listen
$Native = Get-Process -Id $NativeId
if (@($Listener | Where-Object OwningProcess -ne $NativeId).Count -or
    $Native.Path -ne "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe") {
  throw 'Native listener identity mismatch; do not cut over'
}
$Tags = Invoke-RestMethod http://127.0.0.1:11436/api/tags
if ('qwen3:8b' -notin $Tags.models.name) { throw 'Staging model missing' }
Stop-Process -Id $NativeId
if (-not $Native.WaitForExit(20000)) { throw 'Native process did not exit' }
'QWEN_PORT=11435' | Set-Content -Encoding ASCII .env
$env:QWEN_PORT = '11435'
docker compose up -d --wait --wait-timeout 180
if ($LASTEXITCODE -ne 0) { throw 'Cutover failed: execute rollback below' }
Invoke-RestMethod http://127.0.0.1:11435/api/tags
```

Verify again from the Mac through the existing 11435 SSH tunnel, including a
structured Qwen decision, P0 baseline, and `/api/ps` GPU residency. Inspect
`docker compose ps` / `docker inspect` for loopback-only publication and the
NVIDIA device request. Check that the old native PID no longer exists.

If cutover or post-cutover verification fails, or to intentionally revert:

```powershell
Set-Location E:\git\jev-cu-qwen
$ErrorActionPreference = 'Stop'
docker compose stop ollama
if ($LASTEXITCODE -ne 0) { throw 'Container must stop before native restart' }
'QWEN_PORT=11436' | Set-Content -Encoding ASCII .env
$env:QWEN_PORT = '11436'
if (Get-NetTCPConnection -LocalPort 11435 -State Listen -ErrorAction SilentlyContinue) {
  throw 'Port 11435 is still occupied; inspect owner before restarting native'
}
.\start-ollama.ps1
```

Then verify native `/api/tags` and a structured decision over the Mac tunnel.
Do not delete either model store, run `down -v`, or prune volumes. A normal
container restart is `docker compose restart ollama`; follow it with API
verification. `restart: unless-stopped` requires Docker Desktop to be running;
this migration does not change Windows boot/login startup configuration.

## Qwen-Image-2.1 generation/edit service (opt-in profile)

`qwen-image` is a second service in the same Compose project, started only
with `--profile qwen-image`. It serves the official pinned Diffusers
`QwenImage21Pipeline` (`Qwen/Qwen-Image-2.1`), pinned to the merge commit of
the upstream integration PR (#14804, `6256aa7666...`) because no stable
diffusers release contains it yet. Defaults: bfloat16, model CPU offload
(`QWEN_IMAGE_OFFLOAD=sequential` if the 8B text encoder does not fit 16 GB
VRAM with whole-component offload), 512 px, fixed seed 42, single active
request (second concurrent request gets `409 busy`).

Isolation contract: host loopback `127.0.0.1:${QWEN_IMAGE_PORT:-11437}` only,
HuggingFace cache in `./qwen-image-data/cache`, PNG outputs in
`./qwen-image-data/output`. It never touches `./docker-data`, the native
`models/` store, or the ollama ports, and has no restart policy — a Docker
restart never loads a second GPU model.

The first start downloads ~33 GB of weights into the cache bind (run it
detached and monitor `docker compose logs -f qwen-image` until `/health`
reports `"status": "ok"`).

```bash
# stage (from the Mac repo root)
COPYFILE_DISABLE=1 tar --no-xattrs -cf - -C server compose.yaml qwen-image README.md |
  ssh windows 'tar xf - -C /e/git/jev-cu-qwen'

# on Windows: build + start (model downloads on first start)
ssh windows 'cd /e/git/jev-cu-qwen && docker compose --profile qwen-image up -d --build qwen-image'
ssh windows 'curl -s http://127.0.0.1:11437/health'

# Mac client via SSH tunnel (or run on Windows directly)
ssh -fN -o ExitOnForwardFailure=yes -L 127.0.0.1:11437:127.0.0.1:11437 windows
npm run qwen-image -- health
npm run qwen-image -- generate --prompt 'a small red toy cube on a white table' --seed 42 --out /tmp/qwen-t2i.png
npm run qwen-image -- edit --prompt 'make the background a light blue gradient' --image /tmp/qwen-t2i.png --seed 7 --out /tmp/qwen-edit.png

# stop after use (cache/output binds are preserved)
ssh windows 'cd /e/git/jev-cu-qwen && docker compose --profile qwen-image stop qwen-image'
```

GPU coexistence: the ollama container may keep `qwen3:8b` resident in VRAM
(~5.3 GB). If a generation OOMs while ollama is resident, either wait for the
ollama idle unload or restart the ollama container (`docker compose restart
ollama`) before image work; that restart does not alter its model store or
digest.

## Upgrade discipline

No custom image build or extra orchestration is used. Image updates require a
new pinned digest and the same staging/acceptance gates. Never point a test
container at the native rollback model directory. Docker Desktop/WSL/GPU driver
upgrades and cold boot recovery were not covered by the migration acceptance.
