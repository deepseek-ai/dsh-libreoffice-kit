/** Real bridge lifecycle tests and opt-in required hardware pixel comparisons. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
    await callback(module.createImageScaler);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const ready = `import { parentPort } from 'node:worker_threads';
parentPort.postMessage({ backend: 'webgpu', adapter: { device: 'controlled-test-worker' }, limits: {
  maxBufferSize: 268435456, maxStorageBufferBindingSize: 134217728, maxComputeWorkgroupsPerDimension: 65535
}});`;

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
parentPort.on('message', ({ memory, input, output, control }) => {
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
  await withWorker(ready + "parentPort.on('message', () => { throw new Error('No request should reach the GPU.'); });", async create => {
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
  await withWorker(ready + "parentPort.on('message', ({ output }) => { new Uint8Array(output).fill(255); });", async create => {
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

test('device-backed scaling matches the Float64 CPU Lanczos3 reference', { timeout: 60000 }, async t => {
  const scaler = await createImageScaler(options);
  try {
    if (scaler.backend !== 'webgpu') {
      if (process.env.LIBREOFFICE_REQUIRE_GPU === '1') assert.fail(scaler.reason);
      t.skip(scaler.reason);
      return;
    }
    assert.equal(scaler.adapter.isFallbackAdapter, false);
    t.diagnostic(JSON.stringify(scaler.adapter));
    const cases = [
      [80, 80, 40, 40, 'constant'],
      [83, 59, 31, 23, 'mixed'],
      [128, 96, 63, 47, 'checker'],
      [127, 93, 1, 1, 'mixed'],
      [17, 1, 7, 1, 'mixed'],
      [1, 35, 1, 11, 'mixed'],
      [2048, 1536, 511, 383, 'mixed'],
    ];
    for (const [width, height, targetWidth, targetHeight, kind] of cases) {
      const input = pixels(width, height, kind);
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
