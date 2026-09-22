import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createQwenImageClient, runCli } from '../scripts/qwen-image.mjs';

const root = new URL('..', import.meta.url).pathname;

async function readText(rel) {
  return readFile(new URL(rel, new URL('..', import.meta.url)), 'utf8');
}

// Minimal indentation-aware extractor for top-level compose services.
function serviceBlock(composeText, name) {
  const lines = composeText.split(/\r?\n/);
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return null;
  const block = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('  ') && !line.startsWith('   ') && line.trim().endsWith(':')) break;
    block.push(line);
  }
  return block.join('\n');
}

test('compose: ollama service remains exactly the pinned legacy contract', async () => {
  const compose = await readText('server/compose.yaml');
  const ollama = serviceBlock(compose, 'ollama');
  assert.ok(ollama, 'ollama service exists');
  assert.match(ollama, /ollama\/ollama:0\.32\.11@sha256:acc1d61dc30525ecbe11c811462637f474ce9b1c8db80321d1cee81e3ffc7894/);
  assert.match(ollama, /127\.0\.0\.1:\$\{QWEN_PORT:-11436\}:11434/);
  assert.match(ollama, /\.\/docker-data/);
  assert.match(ollama, /restart: unless-stopped/);
});

test('compose: qwen-image opt-in profile service with isolated port, binds and GPU', async () => {
  const compose = await readText('server/compose.yaml');
  const svc = serviceBlock(compose, 'qwen-image');
  assert.ok(svc, 'qwen-image service exists');
  // opt-in profile so default up/rollback never loads a second GPU model
  assert.match(svc, /profiles:\s*\n\s*- qwen-image/);
  // distinct loopback port, never 11434/11435/11436
  assert.match(svc, /127\.0\.0\.1:\$\{QWEN_IMAGE_PORT:-11437\}:8000/);
  // separate cache/output binds; must never mount ./docker-data or native models
  assert.match(svc, /\.\/qwen-image-data\/cache:\/cache/);
  assert.match(svc, /\.\/qwen-image-data\/output:\/output/);
  assert.ok(!/docker-data/.test(svc), 'qwen-image must not touch the ollama store');
  assert.ok(!/\/models/.test(svc), 'qwen-image must not touch native rollback models');
  // GPU reservation identical in kind to ollama
  assert.match(svc, /driver: nvidia/);
  assert.match(svc, /capabilities: \[gpu\]/);
  // HF cache must live on the dedicated bind
  assert.match(svc, /HF_HOME=\/cache/);
  assert.match(svc, /build:/);
});

test('compose: qwen-image does not start with default profile', async () => {
  const compose = await readText('server/compose.yaml');
  const svc = serviceBlock(compose, 'qwen-image');
  assert.ok(svc);
  // restart policy must not resurrect the GPU-heavy service on Docker restarts
  assert.ok(!/restart: unless-stopped/.test(svc), 'qwen-image must not auto-restart');
});

test('Dockerfile: pinned official base image and pinned requirements install', async () => {
  const dockerfile = await readText('server/qwen-image/Dockerfile');
  assert.match(
    dockerfile,
    /pytorch\/pytorch:2\.14\.0-cuda12\.6-cudnn9-runtime@sha256:a77983eb7a3042ccf41a94da547a7f54a47fb70da15c36d67a8e8a329ebaa098/,
  );
  assert.match(dockerfile, /COPY requirements\.txt/);
  assert.match(dockerfile, /pip install --no-cache-dir --break-system-packages -r requirements\.txt/);
  assert.match(dockerfile, /uvicorn.*app\.main:app/);
});

test('requirements: official pinned Qwen-Image-2.1 dependency set', async () => {
  const req = await readText('server/qwen-image/requirements.txt');
  assert.match(
    req,
    /diffusers @ git\+https:\/\/github\.com\/huggingface\/diffusers\.git@6256aa7666cedd47443adc8f82da9a10e110b09c/,
  );
  assert.match(req, /transformers==5\.17\.0/);
  assert.match(req, /accelerate==1\.15\.0/);
  assert.match(req, /huggingface_hub==1\.32\.0/);
  assert.match(req, /pillow==12\.3\.0/);
  assert.match(req, /fastapi==0\.141\.1/);
  assert.match(req, /uvicorn==0\.53\.0/);
});

test('app: official pipeline, bfloat16, cpu offload, 512 default, single-flight', async () => {
  const app = await readText('server/qwen-image/app/main.py');
  assert.match(app, /QwenImage21Pipeline/);
  assert.match(app, /Qwen\/Qwen-Image-2\.1/);
  assert.match(app, /torch\.bfloat16/);
  assert.match(app, /enable_model_cpu_offload/);
  assert.match(app, /DEFAULT_WIDTH = 512/);
  assert.match(app, /DEFAULT_HEIGHT = 512/);
  // one active request: busy rejection contract
  assert.match(app, /HTTP_409_CONFLICT/);
  // invalid/missing image edit contract
  assert.match(app, /HTTP_400_BAD_REQUEST/);
  assert.match(app, /manual_seed/);
});

test('client: health/generate/edit hit the right endpoints with the right payload', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith('/health')) {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', busy: false }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'abc123',
        width: 512,
        height: 512,
        seed: 42,
        sha256: 'f'.repeat(64),
        image_base64: 'aGk=',
        duration_ms: 5,
      }),
    };
  };
  const client = createQwenImageClient({ baseUrl: 'http://127.0.0.1:11437', fetchImpl });
  const health = await client.health();
  assert.deepEqual(health, { status: 'ok', busy: false });

  const out = await client.generate({ prompt: 'a red cube', seed: 42, transparent: true });
  assert.equal(out.sha256, 'f'.repeat(64));
  const gen = calls[1];
  assert.equal(gen.url, 'http://127.0.0.1:11437/generate');
  assert.equal(gen.init.method, 'POST');
  assert.deepEqual(JSON.parse(gen.init.body), {
    prompt: 'a red cube',
    seed: 42,
    transparent: true,
  });

  await client.edit({ prompt: 'make it blue', imageBase64: 'aGk=', seed: 7 });
  const edit = calls[2];
  assert.equal(edit.url, 'http://127.0.0.1:11437/edit');
  assert.equal(JSON.parse(edit.init.body).image_base64, 'aGk=');
});

test('client: busy 409 and invalid-image 400 surface explicit errors', async () => {
  const fetchBusy = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ detail: 'busy: another request is running' }),
  });
  const client = createQwenImageClient({ baseUrl: 'http://x', fetchImpl: fetchBusy });
  await assert.rejects(client.generate({ prompt: 'p' }), /busy/);

  const fetchBad = async () => ({
    ok: false,
    status: 400,
    json: async () => ({ detail: 'image: missing or not a decodable PNG/JPEG' }),
  });
  const client2 = createQwenImageClient({ baseUrl: 'http://x', fetchImpl: fetchBad });
  await assert.rejects(client2.edit({ prompt: 'p' }), /missing or not a decodable/);
});

test('cli: health/generate/edit subcommands drive the client and write PNG bytes', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const fakeClient = {
    health: async () => ({ status: 'ok', busy: false }),
    generate: async (args) => {
      assert.equal(args.prompt, 'cli prompt');
      assert.equal(args.seed, 42);
      return { id: 'id1', width: 512, height: 512, seed: 42, sha256: 'a'.repeat(64), image_base64: png.toString('base64'), duration_ms: 9 };
    },
    edit: async (args) => {
      assert.equal(args.imageBase64, Buffer.from('pngdata').toString('base64'));
      return { id: 'id2', width: 512, height: 512, seed: 7, sha256: 'b'.repeat(64), image_base64: png.toString('base64'), duration_ms: 9 };
    },
  };
  const wrote = [];
  const ctx = {
    client: fakeClient,
    readFile: async (p) => Buffer.from('pngdata'),
    writeFile: async (p, data) => { wrote.push({ p, data }); },
    stdout: (s) => ctx.out.push(s),
    out: [],
  };
  const code = await runCli(['generate', '--prompt', 'cli prompt', '--seed', '42', '--out', 'out.png'], ctx);
  assert.equal(code, 0);
  assert.equal(wrote.length, 1);
  assert.deepEqual(wrote[0].data, png);

  const code2 = await runCli(['edit', '--prompt', 'x', '--image', 'in.png', '--out', 'e.png', '--seed', '7'], ctx);
  assert.equal(code2, 0);
  assert.equal(wrote.length, 2);

  const code3 = await runCli(['health'], ctx);
  assert.equal(code3, 0);
  assert.match(ctx.out.join('\n'), /ok/);

  const code4 = await runCli(['bogus'], ctx);
  assert.equal(code4, 2);
});
