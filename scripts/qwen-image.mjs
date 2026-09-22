#!/usr/bin/env node
// Dependency-free Jev CLI client for the Windows qwen-image service
// (official Diffusers QwenImage21Pipeline, opt-in Compose profile).
// Base URL: --url flag or JEV_CU_QWEN_IMAGE_URL, default http://127.0.0.1:11437
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL =
  process.env.JEV_CU_QWEN_IMAGE_URL || 'http://127.0.0.1:11437';

export function createQwenImageClient({
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch.bind(globalThis),
  timeoutMs = 20 * 60 * 1000,
} = {}) {
  const root = baseUrl.replace(/\/+$/, '');
  async function call(path, body) {
    const init = body === undefined
      ? { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) };
    let res;
    try {
      res = await fetchImpl(`${root}${path}`, init);
    } catch (err) {
      throw new Error(`qwen-image ${path} unreachable: ${err.message}`);
    }
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    if (!res.ok) {
      const detail = payload && payload.detail ? payload.detail : `HTTP ${res.status}`;
      throw new Error(`qwen-image ${path} failed: ${res.status} ${detail}`);
    }
    return payload;
  }
  return {
    baseUrl: root,
    health: () => call('/health'),
    generate: (args = {}) =>
      call('/generate', {
        prompt: args.prompt,
        width: args.width,
        height: args.height,
        steps: args.steps,
        seed: args.seed,
        transparent: args.transparent,
      }),
    edit: (args = {}) =>
      call('/edit', {
        prompt: args.prompt,
        image_base64: args.imageBase64,
        width: args.width,
        height: args.height,
        steps: args.steps,
        seed: args.seed,
      }),
  };
}

function usage() {
  return [
    'usage: qwen-image.mjs [--url BASE] health',
    '       qwen-image.mjs [--url BASE] generate --prompt TEXT [--seed N] [--width N] [--height N] [--steps N] [--transparent] [--out FILE]',
    '       qwen-image.mjs [--url BASE] edit --prompt TEXT --image FILE [--seed N] [--width N] [--height N] [--steps N] [--out FILE]',
    '',
    'env: JEV_CU_QWEN_IMAGE_URL (default http://127.0.0.1:11437)',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { command: null, prompt: undefined, image: undefined, out: undefined,
    seed: undefined, width: undefined, height: undefined, steps: undefined,
    transparent: false, url: undefined };
  const rest = [...argv];
  if (rest.length === 0) return { options, error: 'missing command' };
  options.command = rest.shift();
  while (rest.length) {
    const flag = rest.shift();
    const value = () => {
      if (rest.length === 0) throw new Error(`missing value for ${flag}`);
      return rest.shift();
    };
    switch (flag) {
      case '--prompt': options.prompt = value(); break;
      case '--image': options.image = value(); break;
      case '--out': options.out = value(); break;
      case '--seed': options.seed = Number(value()); break;
      case '--width': options.width = Number(value()); break;
      case '--height': options.height = Number(value()); break;
      case '--steps': options.steps = Number(value()); break;
      case '--transparent': options.transparent = true; break;
      case '--url': options.url = value(); break;
      case '--help': case '-h': return { options, help: true };
      default: throw new Error(`unknown flag ${flag}`);
    }
  }
  return { options };
}

export async function runCli(argv, ctx = {}) {
  const client = ctx.client;
  const readFileImpl = ctx.readFile || readFile;
  const writeFileImpl = ctx.writeFile || writeFile;
  const stdout = ctx.stdout || ((s) => process.stdout.write(`${s}\n`));
  const stderr = ctx.stderr || ((s) => process.stderr.write(`${s}\n`));

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    stderr(`qwen-image: ${err.message}\n${usage()}`);
    return 2;
  }
  if (parsed.help) {
    stdout(usage());
    return 0;
  }
  const { options } = parsed;
  if (options.url && ctx.rebuildClient) ctx.rebuildClient(options.url);

  try {
    if (options.command === 'health') {
      stdout(JSON.stringify(await client.health()));
      return 0;
    }
    if (options.command === 'generate') {
      if (!options.prompt) throw new Error('generate requires --prompt');
      const result = await client.generate({
        prompt: options.prompt, seed: options.seed, width: options.width,
        height: options.height, steps: options.steps, transparent: options.transparent,
      });
      if (options.out) {
        await writeFileImpl(options.out, Buffer.from(result.image_base64, 'base64'));
      }
      const { image_base64, ...meta } = result;
      stdout(JSON.stringify({ ...meta, saved_to: options.out || null }));
      return 0;
    }
    if (options.command === 'edit') {
      if (!options.prompt) throw new Error('edit requires --prompt');
      if (!options.image) throw new Error('edit requires --image');
      const bytes = await readFileImpl(options.image);
      const result = await client.edit({
        prompt: options.prompt, imageBase64: Buffer.from(bytes).toString('base64'),
        seed: options.seed, width: options.width, height: options.height, steps: options.steps,
      });
      if (options.out) {
        await writeFileImpl(options.out, Buffer.from(result.image_base64, 'base64'));
      }
      const { image_base64, ...meta } = result;
      stdout(JSON.stringify({ ...meta, saved_to: options.out || null }));
      return 0;
    }
    stderr(`qwen-image: unknown command '${options.command}'\n${usage()}`);
    return 2;
  } catch (err) {
    stderr(`qwen-image: ${err.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const baseFromFlag = process.argv.slice(2).findIndex((a) => a === '--url');
  const urlOverride = baseFromFlag !== -1 ? process.argv.slice(2)[baseFromFlag + 1] : undefined;
  const client = createQwenImageClient(urlOverride ? { baseUrl: urlOverride } : {});
  process.exitCode = await runCli(process.argv.slice(2), {
    client,
    rebuildClient: (url) => { Object.assign(client, createQwenImageClient({ baseUrl: url })); },
  });
}
