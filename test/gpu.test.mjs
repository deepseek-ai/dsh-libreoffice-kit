/** Real bridge lifecycle tests and opt-in required hardware pixel comparisons. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createImageScaler } from '../packages/entry/src/gpu/index.mjs';
import { scaleLayout } from '../packages/entry/src/gpu/layout.mjs';
import { cpuScale, pixelError, pixels } from './gpu-reference.mjs';

const options = { maxGpuBytes: 512 * 1024 * 1024, timeoutMs: 10000 };

// Only the asynchronous GPU boundary is replaced; each case retains the real bridge and worker lifecycle.
async function withWorker(source, callback) {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-gpu-test-'));
  try {
    await cp(new URL('../packages/entry/src/gpu/', import.meta.url), root, { recursive: true });
    await writeFile(join(root, 'worker.mjs'), source);
    const module = await import(pathToFileURL(join(root, 'index.mjs')).href);
    await callback(module.createImageScaler, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ready = `import { parentPort } from 'node:worker_threads';
const onScale = callback => parentPort.on('message', message => {
  if (message.kind === 'dispose') { parentPort.postMessage({ kind: 'disposed' }); parentPort.close(); }
  else callback(message);
});
parentPort.postMessage({ backend: 'webgpu', adapter: { device: 'controlled-test-worker' }, limits: {
  maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728, maxComputeWorkgroupsPerDimension: 65535
}});`;

test('GPU workers omit Node flags inherited from ESM eval consumers', async () => {
  await withWorker(`if (process.execArgv.length !== 0) throw new Error('Consumer Node flags reached the GPU worker.');
${ready}
onScale(() => {});`, async (_, root) => {
    const source = `import assert from 'node:assert/strict';
import {createImageScaler} from ${JSON.stringify(pathToFileURL(join(root, 'index.mjs')).href)};
const scaler=await createImageScaler(${JSON.stringify({ ...options, mode: 'webgpu' })});
try {assert.equal(scaler.backend,'webgpu',scaler.reason);} finally {await scaler.dispose();}`;
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', source], { env, timeout: 20_000, killSignal: 'SIGKILL' });
  });
});

test('disabled GPU delegates without changing source or output', async () => {
  const scaler = await createImageScaler({ ...options, mode: 'off' });
  const memory = new SharedArrayBuffer(80);
  new Uint8Array(memory).fill(93);
  assert.equal(scaler.backend, 'cpu');
  assert.equal(scaler.scaleImage(memory, 0, 64, 4, 4, 2, 2), false);
  assert.ok(new Uint8Array(memory).every(value => value === 93));
  await scaler.dispose();
  await scaler.dispose();
});

test('invalid public limits fail before worker acquisition', async () => {
  for (const override of [{ maxGpuBytes: 0 }, { timeoutMs: NaN }, { initializationTimeoutMs: 0x80000000 }, { mode: 'invalid' }]) {
    await assert.rejects(createImageScaler({ ...options, ...override }));
  }
  assert.equal(scaleLayout(16, 16, 8, 8, 1), null);
  assert.equal(scaleLayout(8, 8, 16, 16, options.maxGpuBytes), null);
  assert.equal(scaleLayout(8, 8, 8, 8, options.maxGpuBytes), null);
  assert.equal(scaleLayout(0x7fffffff, 0x7fffffff, 1, 1, Number.MAX_SAFE_INTEGER), null);
});

test('synchronous callback copies completed staging without sharing WASM allocations', async () => {
  await withWorker(`${ready}
onScale(({ memory, input, output, control }) => {
  if (memory !== undefined) throw new Error('WASM memory must stay with the caller.');
  new Uint8Array(input).fill(199);
  new Uint8Array(output).fill(137);
  Atomics.store(new Int32Array(control), 0, 1);
  Atomics.notify(new Int32Array(control), 0);
});`, async create => {
    const scaler = await create(options);
    try {
      const memory = new SharedArrayBuffer(80);
      new Uint8Array(memory).fill(19);
      assert.equal(scaler.scaleImage(memory, 0, 64, 4, 4, 2, 2), true);
      assert.ok(new Uint8Array(memory, 0, 64).every(value => value === 19));
      assert.ok(new Uint8Array(memory, 64).every(value => value === 137));
      assert.deepEqual(scaler.stats, { attempted: 1, accelerated: 1, declined: 0, failed: 0 });
    } finally { await scaler.dispose(); }
  });
});

test('over-budget and invalid memory requests leave the worker available', async () => {
  await withWorker(ready + "onScale(() => { throw new Error('No request should reach the GPU.'); });", async create => {
    const scaler = await create({ ...options, maxGpuBytes: 8192 });
    try {
      const memory = new SharedArrayBuffer(80);
      new Uint8Array(memory).fill(83);
      assert.equal(scaler.scaleImage(memory, 0, 64, 400, 400, 200, 200), false);
      assert.equal(scaler.scaleImage(memory, -1, 64, 4, 4, 2, 2), false);
      assert.equal(scaler.scaleImage(memory, 0, 79, 4, 4, 2, 2), false);
      assert.equal(scaler.backend, 'webgpu');
      assert.ok(new Uint8Array(memory).every(value => value === 83));
    } finally { await scaler.dispose(); }
  });
});

test('unresponsive GPU times out, preserves WASM output and stops accepting work', { timeout: 30000 }, async () => {
  await withWorker(ready + "onScale(({ output }) => { new Uint8Array(output).fill(255); });", async create => {
    const scaler = await create({ ...options, timeoutMs: 10, initializationTimeoutMs: 10000 });
    try {
      const memory = new SharedArrayBuffer(80);
      new Uint8Array(memory).fill(73);
      assert.equal(scaler.scaleImage(memory, 0, 64, 4, 4, 2, 2), false);
      assert.match(scaler.reason, /timed out/);
      assert.equal(scaler.backend, 'cpu');
      assert.equal(scaler.scaleImage(memory, 0, 64, 4, 4, 2, 2), false);
      assert.ok(new Uint8Array(memory).every(value => value === 73));
      assert.equal(scaler.stats.failed, 1);
    } finally { await scaler.dispose(); }
  });
});

test('worker startup errors and initialization stalls select CPU and dispose', { timeout: 30000 }, async () => {
  for (const source of ["throw new Error('controlled startup failure');", "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {});"]) {
    await withWorker(source, async create => {
      const scaler = await create({ ...options, initializationTimeoutMs: source.startsWith('throw') ? 10000 : 10 });
      assert.equal(scaler.backend, 'cpu');
      assert.match(scaler.reason, /controlled startup failure|timed out/);
      await scaler.dispose();
    });
  }
});

test('automatic selection tries WebGPU, WebGL2, then WebGL1 and applies texture limits', async () => {
  await withWorker(`import { parentPort, workerData } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./attempts.jsonl', import.meta.url), workerData.mode + '\\n');
if (workerData.mode !== 'webgl1') parentPort.postMessage({ backend: 'cpu', reason: 'controlled provider unavailable' });
else parentPort.postMessage({ backend: 'webgl1', adapter: { device: 'controlled-webgl1' }, limits: { maxTextureSize: 4 } });
parentPort.on('message', ({ kind, output, control }) => {
  if (kind === 'dispose') { parentPort.postMessage({ kind: 'disposed' }); parentPort.close(); return; }
  new Uint8Array(output).fill(117);
  Atomics.store(new Int32Array(control), 0, 1); Atomics.notify(new Int32Array(control), 0);
});`, async (create, root) => {
    const scaler = await create(options);
    try {
      assert.equal(scaler.backend, 'webgl1');
      assert.equal(await readFile(join(root, 'attempts.jsonl'), 'utf8'), 'webgpu\nwebgl2\nwebgl1\n');
      const memory = new SharedArrayBuffer(96);
      new Uint8Array(memory).fill(29);
      assert.equal(scaler.scaleImage(memory, 0, 80, 5, 4, 2, 2), false);
      assert.ok(new Uint8Array(memory).every(value => value === 29));
      assert.equal(scaler.scaleImage(memory, 0, 64, 4, 4, 2, 2), true);
      assert.ok(new Uint8Array(memory, 64, 16).every(value => value === 117));
      assert.equal(scaler.stats.accelerated, 1);
    } finally { await scaler.dispose(); }
  });
});

test('explicit GPU selection does not initialize any alternative provider', async () => {
  await withWorker(`import { parentPort, workerData } from 'node:worker_threads';
import { appendFileSync } from 'node:fs';
appendFileSync(new URL('./attempts.jsonl', import.meta.url), workerData.mode + '\\n');
parentPort.postMessage({ backend: 'cpu', reason: 'controlled provider unavailable' });
parentPort.on('message', () => {});`, async (create, root) => {
    const scaler = await create({ ...options, mode: 'webgl2' });
    try {
      assert.equal(scaler.backend, 'cpu');
      assert.match(scaler.reason, /webgl2.*controlled provider unavailable/);
      assert.equal(await readFile(join(root, 'attempts.jsonl'), 'utf8'), 'webgl2\n');
    } finally { await scaler.dispose(); }
  });
});

test('stalled and failed initialization release worker-owned listeners before the next backend starts', { timeout: 30_000 }, async () => {
  await withWorker(`import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:net';
const server = createServer();
const portFile = new URL('./port', import.meta.url);
const port = workerData.mode === 'webgpu' ? 0 : Number(readFileSync(portFile, 'utf8'));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
appendFileSync(new URL('./acquired.jsonl', import.meta.url), workerData.mode + '\\n');
if (workerData.mode === 'webgpu') writeFileSync(portFile, String(server.address().port));
else if (workerData.mode === 'webgl2') throw new Error('controlled startup failure after listener acquisition');
else parentPort.postMessage({ backend: 'webgl1', adapter: {}, limits: { maxTextureSize: 8 } });
parentPort.on('message', message => {
  if (message.kind === 'dispose') server.close(() => { parentPort.postMessage({ kind: 'disposed' }); parentPort.close(); });
});`, async (create, root) => {
    const scaler = await create({ ...options, initializationTimeoutMs: 5_000 });
    try {
      assert.equal(scaler.backend, 'webgl1', scaler.reason);
      assert.equal(await readFile(join(root, 'acquired.jsonl'), 'utf8'), 'webgpu\nwebgl2\nwebgl1\n');
    } finally { await scaler.dispose(); }
  });
});

test('successful GPU disposal executes provider cleanup before resolving', async () => {
  await withWorker(`${ready}
import { writeFileSync } from 'node:fs';
parentPort.on('message', message => {
  if (message.kind !== 'dispose') return;
  writeFileSync(new URL('./disposed', import.meta.url), 'provider cleanup completed');
});
onScale(() => {});`, async (create, root) => {
    const scaler = await create(options);
    await scaler.dispose();
    assert.equal(await readFile(join(root, 'disposed'), 'utf8'), 'provider cleanup completed');
  });
});

test('unresponsive GPU disposal rejects after terminating its worker', async () => {
  await withWorker(ready + "parentPort.on('message', () => {});", async create => {
    const scaler = await create({ ...options, timeoutMs: 10, initializationTimeoutMs: 10000 });
    await assert.rejects(scaler.dispose(), /GPU disposal timed out/);
    assert.equal(scaler.backend, 'cpu');
  });
});

test('device-backed scaling matches the Float64 CPU Lanczos3 reference', { timeout: 60000 }, async t => {
  const requested = process.env.LIBREOFFICE_GPU_BACKEND ?? 'webgpu';
  const scaler = await createImageScaler({ ...options, mode: requested });
  try {
    if (scaler.backend !== requested) {
      if (process.env.LIBREOFFICE_REQUIRE_GPU === '1') assert.fail(scaler.reason);
      t.skip(scaler.reason);
      return;
    }
    assert.equal(scaler.adapter.isFallbackAdapter, false);
    t.diagnostic(JSON.stringify(scaler.adapter));
    const cases = [
      [80, 80, 40, 40, 'constant'],
      [83, 59, 31, 23, 'mixed'],
      [83, 59, 31, 23, 'alpha'],
      [128, 96, 63, 47, 'checker'],
      [127, 93, 1, 1, 'mixed'],
      [17, 1, 7, 1, 'mixed'],
      [1, 35, 1, 11, 'mixed'],
      [2048, 1536, 511, 383, 'mixed'],
    ];
    for (const [width, height, targetWidth, targetHeight, kind] of cases) {
      const input = pixels(width, height, kind);
      if (kind === 'alpha') for (let offset = 3; offset < input.length; offset += 4) input[offset] = (offset * 31) % 256;
      const memory = new SharedArrayBuffer(input.length + targetWidth * targetHeight * 4);
      new Uint8Array(memory).set(input);
      assert.equal(scaler.scaleImage(memory, 0, input.length, width, height, targetWidth, targetHeight), true, scaler.reason);
      const expected = cpuScale(input, width, height, targetWidth, targetHeight);
      const error = pixelError(new Uint8Array(memory, input.length), expected);
      assert.ok(error.maximum <= 1, JSON.stringify({ width, height, targetWidth, targetHeight, kind, error }));
      assert.deepEqual(new Uint8Array(memory, 0, input.length), input);
      t.diagnostic(JSON.stringify({ size: `${width}x${height}->${targetWidth}x${targetHeight}`, kind, error }));
    }
    assert.equal(scaler.stats.accelerated, cases.length);
  } finally { await scaler.dispose(); }
});
