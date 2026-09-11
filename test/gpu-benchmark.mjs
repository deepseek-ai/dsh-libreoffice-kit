/** Run explicitly with --benchmark; timings include staging, upload, two passes and readback. */
import assert from 'node:assert/strict';
import { createImageScaler } from '../packages/entry/src/gpu/index.mjs';
import { cpuScale, pixelError, pixels } from './gpu-reference.mjs';

if (process.argv.includes('--benchmark')) {
  const start = performance.now();
  const scaler = await createImageScaler({ maxGpuBytes: 512 * 1024 * 1024, timeoutMs: 30000 });
  const initializationMs = performance.now() - start;
  try {
    assert.equal(scaler.backend, 'webgpu', scaler.reason);
    const rows = [];
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (const [width, height, targetWidth, targetHeight] of [
      [512, 512, 128, 128],
      [2048, 1536, 1024, 768],
      [4096, 3072, 1024, 768],
      [4096, 3072, 256, 192],
    ]) {
      const input = pixels(width, height);
      const memory = new SharedArrayBuffer(input.length + targetWidth * targetHeight * 4);
      new Uint8Array(memory).set(input);
      const gpuTimes = [], cpuTimes = [];
      let expected;
      for (let repetition = 0; repetition < 7; repetition++) {
        const gpuStart = performance.now();
        assert.equal(scaler.scaleImage(memory, 0, input.length, width, height, targetWidth, targetHeight), true, scaler.reason);
        const gpuMs = performance.now() - gpuStart;
        const cpuStart = performance.now();
        expected = cpuScale(input, width, height, targetWidth, targetHeight);
        const cpuMs = performance.now() - cpuStart;
        if (repetition >= 2) { gpuTimes.push(gpuMs); cpuTimes.push(cpuMs); }
      }
      const error = pixelError(new Uint8Array(memory, input.length), expected);
      assert.ok(error.maximum <= 1, JSON.stringify(error));
      rows.push({ width, height, targetWidth, targetHeight, gpuMedianMs: median(gpuTimes), cpuJsMedianMs: median(cpuTimes), gpuTimes, cpuTimes, error });
    }
    console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, adapter: scaler.adapter,
      initializationMs, cpuReference: 'Float64 JavaScript Lanczos3, not LibreOffice C++', warmups: 2, repetitions: 5, rows, stats: scaler.stats,
      peakProcessRssMiB: process.resourceUsage().maxRSS / 1024 }, null, 2));
  } finally { await scaler.dispose(); }
}
