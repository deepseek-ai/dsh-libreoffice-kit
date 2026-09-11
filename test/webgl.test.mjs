/** Hardware WebGL contexts execute the same pixel fixtures as the WebGPU filter. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebGlScaler } from '../packages/entry/src/gpu/webgl.mjs';
import { scaleLayout } from '../packages/entry/src/gpu/layout.mjs';
import { cpuScale, pixelError, pixels } from './gpu-reference.mjs';

for (const version of [2, 1]) {
  test(`WebGL ${version} hardware scaling matches the Float64 Lanczos3 reference`, { timeout: 60000 }, t => {
    let scaler;
    try { scaler = createWebGlScaler(version); }
    catch (error) {
      if (process.env.LIBREOFFICE_REQUIRE_WEBGL === '1') throw error;
      t.skip(error.message);
      return;
    }
    try {
      assert.equal(scaler.adapter.isFallbackAdapter, false);
      t.diagnostic(JSON.stringify(scaler.adapter));
      for (const [width, height, targetWidth, targetHeight, kind] of [
        [80, 80, 40, 40, 'constant'], [83, 59, 31, 23, 'mixed'],
        [128, 96, 63, 47, 'checker'], [127, 93, 1, 1, 'mixed'],
        [17, 1, 7, 1, 'mixed'], [1, 35, 1, 11, 'mixed'],
        [2048, 1536, 511, 383, 'mixed'],
      ]) {
        const input = pixels(width, height, kind);
        const source = new Uint8Array(input).buffer;
        const layout = scaleLayout(width, height, targetWidth, targetHeight, 512 * 1024 * 1024);
        const output = new ArrayBuffer(layout.outputBytes);
        scaler.scale(layout, source, output);
        const error = pixelError(new Uint8Array(output), cpuScale(input, width, height, targetWidth, targetHeight));
        assert.ok(error.maximum <= 1, JSON.stringify({ width, height, targetWidth, targetHeight, kind, error }));
        assert.deepEqual(new Uint8Array(source), input);
        t.diagnostic(JSON.stringify({ size: `${width}x${height}->${targetWidth}x${targetHeight}`, kind, error }));
      }
    } finally { scaler.dispose(); scaler.dispose(); }
  });
}

test('concurrent WebGL workers own constructor references and keep surviving displays usable', { timeout: 60000 }, async t => {
  const { createRequire } = await import('node:module');
  const { dirname, join } = await import('node:path');
  const { Worker } = await import('node:worker_threads');
  const { once } = await import('node:events');
  const require = createRequire(new URL('../packages/entry/package.json', import.meta.url));
  let probe;
  try { probe = createWebGlScaler(2); }
  catch (error) {
    if (process.env.LIBREOFFICE_REQUIRE_WEBGL === '1') throw error;
    t.skip(error.message);
    return;
  }
  probe.dispose();
  const root = dirname(require.resolve('@deepseek-ai/libreoffice-kit-wasm/prebuilds.json'));
  const binding = join(root, 'assets/graphics', `${process.platform}-${process.arch}`, 'nodejs_gl_binding.node');
  const workers = [2, 1].map((version, index) => new Worker(new URL('./webgl-worker-fixture.mjs', import.meta.url), {
    workerData: { binding, version, color: 51 + index * 83 },
  }));
  const message = worker => once(worker, 'message', { signal: AbortSignal.timeout(30000) });
  const request = (worker, value) => { const reply = message(worker); worker.postMessage(value); return reply; };
  try {
    assert.deepEqual(await Promise.all(workers.map(message)), [['ready'], ['ready']]);
    const results = await Promise.all(workers.map(worker => request(worker, 'scale')));
    for (let index = 0; index < results.length; index++) assert.ok(results[index][0].pixels.every(value => value === 51 + index * 83));
    assert.deepEqual(await request(workers[0], 'dispose'), ['disposed']);
    const [survivor] = await request(workers[1], 'scale');
    assert.ok(survivor.pixels.every(value => value === 134));
    assert.deepEqual(await request(workers[1], 'dispose'), ['disposed']);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }
});
