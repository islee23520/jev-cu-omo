# jev-cu-omo

`jev-cu-omo` is an OmO extension for verified native macOS computer use. It
combines a typed decision backend with the existing `cua-driver` accessibility
driver, a local policy gate, dry-run previews, and exact post-action
verification.

This repository is a fork of [Sac-Y/Jev-cu](https://github.com/Sac-Y/Jev-cu)
with an OmO tool, a macOS `cua-driver` adapter, and an optional self-hosted Qwen
decision backend. It does not modify OmO model-provider settings. Browser tasks
remain outside this package and should use Aside.

## What the package installs

OmO reads the package metadata in `package.json` and loads:

- `extension/jev-cu.mjs` - registers the `jev_cu` tool.
- `skill/jev-use/` - teaches OmO when and how to use the tool safely.

The tool supports two operations:

- `observe` reads the selected native macOS window without making a model
  decision.
- `run` asks the configured decision backend for the next action, applies the
  local policy gate, executes through `cua-driver`, observes again, and checks
  the caller-provided result criterion.

Supported applications are currently Calculator, TextEdit, and Calendar.

## Requirements

- macOS with Accessibility and Screen Recording permission granted to
  `CuaDriver.app`.
- A working [`cua-driver`](https://github.com/trycua/cua-driver) installation.
- OmO with package installation support (`omo install --help`).
- Node.js 20 or newer for repository tests.
- One decision backend:
  - TypeSafe System One with `TYPESAFE_API_KEY`; or
  - the optional self-hosted Qwen backend described in
    [`server/README.md`](server/README.md).

Check the driver before installing the package:

```bash
cua-driver status
cua-driver check_permissions '{"prompt":false}'
```

Both `accessibility` and `screen_recording` must be granted. Start the packaged
daemon if it is not already running, following the `cua-driver` documentation.

## Install in OmO

### Install globally from GitHub

This is the normal installation for daily OmO use. It adds the package to the
user-level OmO settings, so it is available in every workspace:

```bash
omo install https://github.com/islee23520/jev-cu-omo
```

Confirm that OmO registered the package:

```bash
omo list
```

Then close the current OmO session and start a new one:

```bash
omo
```

Extensions and skills are discovered when a session starts. Installing the
package does not retroactively add `jev_cu` to a session that was already
running.

### Install only for one project

Run this from the target project directory when the package should be enabled
only for that project:

```bash
omo install -l https://github.com/islee23520/jev-cu-omo
```

This writes the package entry to the project's `.omo/settings.json` instead of
the user-level settings. Start OmO in that project after installation. If OmO
asks whether to trust project-local files, review them and approve the project
before using the extension.

### Install a local checkout for development

```bash
git clone https://github.com/islee23520/jev-cu-omo.git
cd jev-cu-omo
npm test
omo install .
```

Use `omo install -l .` instead when the checkout should be registered only in
the current project.

## Configure a decision backend

### TypeSafe System One

Store the API key outside the repository:

```bash
mkdir -p ~/.config/jev-cu
printf 'TYPESAFE_API_KEY=%s\n' 'replace-with-your-key' \
  > ~/.config/jev-cu/typesafe.env
chmod 600 ~/.config/jev-cu/typesafe.env
```

The extension reads that file by default. You may instead set
`TYPESAFE_API_KEY`, or point `JEV_CU_ENV_FILE` at another environment file.
TypeSafe access may be invite-only; without a working key, only observation and
local-backend flows can be tested.

### Self-hosted Qwen

The optional backend uses Ollama's `/api/chat` endpoint and does not require a
TypeSafe key:

```bash
export JEV_CU_DECIDER=qwen
export JEV_CU_QWEN_URL=http://127.0.0.1:11435
export JEV_CU_QWEN_MODEL=qwen3:8b
omo
```

The measured repository baseline for `qwen3:8b` is 10/12 on the P0 fixture set,
not perfect accuracy. Exact result verification remains mandatory. See
[`server/README.md`](server/README.md) for Docker, GPU, SSH tunnel, staging,
cutover, and rollback instructions, and [`BENCHMARK.md`](BENCHMARK.md) for the
recorded 8B/14B comparison.

### Local Laya (experimental open-weight decision backend)

[Laya](https://huggingface.co/convaiinnovations/laya) is a local,
non-autoregressive typed-decision model. It does not see screenshots and does
not replace `cua-driver`; it selects among a small set of AX candidates after
the OmO planner has decided the next step.

Laya 0.3.4 supports Python 3.8-3.12. This Mac's system Python may be newer, so
install the pinned Python 3.12 environment with:

```bash
npm run setup-laya
```

The first prediction downloads the selected Hugging Face checkpoint. Run OmO
with the English checkpoint for the current English GUI goals:

```bash
export JEV_CU_DECIDER=laya
export JEV_CU_LAYA_MODEL=english
omo --model cpa/gpt-5.6-sol
```

The execution split is intentional:

- `cpa/gpt-5.6-sol` plans the task, supplies a concrete per-step goal, the
  authorized action and any text/key resources.
- Laya selects the target from a bounded AX candidate set. Keep
  `candidateMax` between 3 and 8; its documented accuracy degrades with large
  option sets.
- Local policy gates sensitive target labels.
- Exact post-action `verify` determines completion. Base Laya's zero-shot
  `done` and `risk` heads are not used as proof for this GUI domain.

The base English checkpoint is **not a drop-in replacement for TypeSafe Jev**.
On this repository's 12-case P0 AX benchmark it scored 2/12 with eight
candidates. Treat it as experimental until it is fine-tuned on the project's
GUI traces. Use dry-run and exact verification; do not enable unattended real
execution from the base checkpoint.

Example OmO request shape:

```json
{
  "operation": "run",
  "app": "Calculator",
  "pid": 123,
  "windowId": 456,
  "goal": "Click the digit 7 button.",
  "stepGoals": ["Click the digit 7 button."],
  "candidateMax": 5,
  "dryRun": true,
  "verify": { "role": "AXStaticText", "value": "7" }
}
```

Offline candidate-selection benchmark:

```bash
npm run p0-laya
```

## Verify the installed tool

First ask OmO to observe a dedicated Calculator test window. OmO must use
`cua-driver` to obtain a fresh `pid` and `windowId`; do not copy identifiers
from documentation or another session.

The underlying tool call has this shape:

```json
{
  "operation": "observe",
  "app": "Calculator",
  "pid": 123,
  "windowId": 456
}
```

A successful result has `status: "observed"` and includes structured elements.
Observation does not require a TypeSafe key.

For a new action flow, preview one step first:

```json
{
  "operation": "run",
  "app": "Calculator",
  "pid": 123,
  "windowId": 456,
  "goal": "Calculate 6 multiplied by 7.",
  "dryRun": true,
  "maxSteps": 8,
  "verify": {
    "role": "AXStaticText",
    "label": "Result",
    "value": "42"
  }
}
```

The role, label, and value above are examples. Build `verify` from the actual
fresh observation. After reviewing the dry-run result and confirming that the
action is authorized, repeat with `dryRun: false`. A task succeeds only when the
tool returns `status: "done"` and `verified: true`.

More examples are in
[`skill/jev-use/references/runtime.md`](skill/jev-use/references/runtime.md).

## Isolated validation before installation

The isolated command below is for maintainers testing a checkout. It loads the
extension and skill explicitly while disabling normal discovery. It does **not**
install the package into everyday OmO settings:

```bash
tmp_dir="$(mktemp -d)"
OMO_CODING_AGENT_DIR="$tmp_dir/omo" \
  omo --no-extensions --no-skills --no-context-files \
  -e ./extension/jev-cu.mjs --skill ./skill/jev-use
```

Use this path to prove that a working tree loads cleanly before publishing.
Use `omo install https://github.com/islee23520/jev-cu-omo` for the real global
installation.

## Update or remove

Update installed packages with:

```bash
omo update https://github.com/islee23520/jev-cu-omo
```

If the installed source shown by `omo list` is normalized differently, pass
that exact source string to `omo update` or `omo remove`.

Remove the global installation with:

```bash
omo remove https://github.com/islee23520/jev-cu-omo
```

Remove a project-local installation from the project directory with:

```bash
omo remove -l https://github.com/islee23520/jev-cu-omo
```

Start a new OmO session after an update or removal.

## Development and validation

```bash
npm test
npm run p0
```

`npm test` runs unit and integration tests without calling the TypeSafe API.
`npm run p0` uses the real TypeSafe backend and exits non-zero on an API error or
wrong selection. A passing mock test is not a substitute for a real backend and
real macOS GUI verification.

### Experimental Blender semantic decision benchmark

### Verified Zcode-reviewed face and neck repair

For the canonical connected Seoul Kenshi female mesh, run the verified
topology-preserving repair:

```bash
npm run blender-face-repair -- /absolute/path/female-base-symmetric.blend /absolute/output-directory
```

The command creates a repaired Blend, a machine-readable implementation log,
and five 900x900 review renders. It verifies the input fingerprint, keeps
26,440 torso vertices unchanged, preserves the exact topology, and rejects a
result outside the required structural and proportion bounds. The final tested
result measured 7.127 head heights and received a PASS from local Zcode/ZAI
vision (`glm-5.3-flash`). Astra was not used.

See [`docs/BLENDER-FACE-REPAIR.md`](docs/BLENDER-FACE-REPAIR.md) for the exact
contract, evidence summary, outputs, and limitations.

### Other experimental Blender decision benchmarks

Blender's 3D viewport is not an AX-addressable `jev_cu` application. The
experimental benchmark therefore gives the local decision backend a bounded
set of semantic head-fit presets and applies the selected preset through
Blender's Python API. It does not claim visual quality; a human must review the
output `.blend` and renders.

```bash
JEV_CU_QWEN_URL=http://127.0.0.1:11435 \
JEV_CU_QWEN_MODEL=qwen3:8b \
npm run blender-head-fit -- input.blend output.blend
```

The JSON result reports the selected preset, decision-model latency, Blender
application time, and `visualReview: "required"`. The command edits only the
output file and preserves the input file.

For a vision-reviewed boundary, use the experimental autonomous variant. A
vision reviewer defines the locked region and falloff band, while the decision
backend chooses the bounded morph operation after each structured observation:

```bash
JEV_CU_QWEN_URL=http://127.0.0.1:11435 \
JEV_CU_QWEN_MODEL=qwen3:8b \
npm run blender-vision-autonomous -- input.blend output.blend
```

This path preserves the connected topology, never cuts or bridges the mesh,
and marks the result as requiring final human visual approval.

Repository layout:

```text
extension/       OmO tool registration
skill/jev-use/   OmO skill and runtime reference
scripts/         decision adapters, policy, loop, and cua-driver adapter
fixtures/        AX and P0 fixtures
tests/           Node.js tests
server/          optional self-hosted Qwen service
```

## Safety model

- Dry-run is the default.
- Real execution requires an exact observable verification criterion.
- Deletion, sending, payment, permission changes, uploads, CAPTCHA handling,
  installation, system settings, and credential entry stop for confirmation.
- UI text is treated as data, not as instructions.
- Every action is followed by a fresh observation.
- A model-reported completion, timeout, takeover, or `max_steps` result is not
  counted as success.
- Browser automation is not supported by this package; use Aside instead.

See [`QA.md`](QA.md) for measured validation evidence and known limitations.
