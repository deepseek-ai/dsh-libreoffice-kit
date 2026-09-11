/** One hardware provider per worker, separate from the synchronously blocked WASM worker. */
import { parentPort, workerData } from 'node:worker_threads';
import { createWebGpuScaler } from './webgpu.mjs';
import { createWebGlScaler } from './webgl.mjs';

try {
  const mode = workerData.mode;
  let scaler;
  if (mode === 'webgpu') scaler = await createWebGpuScaler(await import('webgpu'));
  else if (mode === 'webgl2' || mode === 'webgl1') scaler = createWebGlScaler(mode === 'webgl2' ? 2 : 1);
  else throw new Error(`Unsupported GPU worker mode: ${mode}`);
  parentPort.on('message', async message => {
    if (message.kind === 'dispose') {
      try { await scaler.dispose(); parentPort.postMessage({ kind: 'disposed' }); }
      catch (error) { parentPort.postMessage({ kind: 'dispose-error', reason: String(error) }); }
      finally { parentPort.close(); }
      return;
    }
    const { layout, input, output, control } = message;
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
  parentPort.postMessage({ backend: mode, adapter: scaler.adapter, limits: scaler.limits });
} catch (error) {
  parentPort.postMessage({ backend: 'cpu', reason: error instanceof Error ? error.message : String(error) });
  parentPort.close();
}
