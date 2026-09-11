/** Asynchronous Dawn work runs separately from the synchronously blocked WASM worker. */
import { parentPort } from 'node:worker_threads';
import { createWebGpuScaler } from './webgpu.mjs';

try {
  const scaler = await createWebGpuScaler(await import('webgpu'));
  parentPort.on('message', async ({ layout, input, output, control }) => {
    const state = new Int32Array(control);
    try {
      await scaler.scale(layout, input, output);
      Atomics.store(state, 0, 1);
    } catch {
      // A rejected GPU operation leaves LibreOffice's original pixels untouched.
      Atomics.store(state, 0, -1);
    } finally {
      Atomics.notify(state, 0);
    }
  });
  parentPort.postMessage({ backend: 'webgpu', adapter: scaler.adapter, limits: scaler.limits });
} catch (error) {
  parentPort.postMessage({ backend: 'cpu', reason: error instanceof Error ? error.message : String(error) });
  parentPort.close();
}
