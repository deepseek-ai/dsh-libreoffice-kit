/** Optional Node WebGPU image scaling for LibreOffice's synchronous WASM callback. */
import { Worker } from 'node:worker_threads';
import { scaleLayout } from './layout.mjs';

/**
 * Initialize GPU work before entering LibreOffice's synchronous conversion.
 * A false scaleImage result preserves output and delegates to LibreOffice's CPU filter.
 * Call from the conversion worker: scaleImage blocks its caller for at most timeoutMs.
 * @param {object} options Explicit pixel-memory and per-operation time limits.
 * @returns {Promise<object>} A synchronous scaleImage callback and awaited disposal.
 */
export async function createImageScaler({ maxGpuBytes, timeoutMs, initializationTimeoutMs = timeoutMs, mode = 'auto' }) {
  for (const [name, value] of Object.entries({ maxGpuBytes, timeoutMs, initializationTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  }
  if (timeoutMs > 0x7fffffff || initializationTimeoutMs > 0x7fffffff) throw new RangeError('GPU time limits exceed the Node timer range.');
  if (mode !== 'auto' && mode !== 'off') throw new TypeError('GPU mode must be auto or off.');
  let worker;
  let termination;
  let terminationError;
  let backend = 'cpu';
  let reason = 'GPU scaling is disabled.';
  let adapter;
  let limits;
  const counts = { attempted: 0, accelerated: 0, declined: 0, failed: 0 };
  const stop = message => {
    backend = 'cpu';
    reason = message;
    if (worker && !termination) {
      termination = worker.terminate().catch(error => { terminationError = error; });
    }
  };
  if (mode === 'auto') {
    try {
      worker = new Worker(new URL('./worker.mjs', import.meta.url), { name: 'libreoffice-image-gpu' });
      worker.on('error', error => { stop(`WebGPU worker failed: ${error.message}`); });
      worker.on('exit', code => { if (backend === 'webgpu') stop(`WebGPU worker exited (${code}).`); });
      const ready = await new Promise((resolve, reject) => {
        const finish = callback => value => {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
          callback(value);
        };
        const onMessage = finish(resolve);
        const onError = finish(reject);
        const onExit = finish(code => reject(new Error(`WebGPU worker exited during initialization (${code}).`)));
        const timer = setTimeout(() => onError(new Error('WebGPU initialization timed out.')), initializationTimeoutMs);
        worker.once('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
      });
      if (ready.backend === 'webgpu') {
        backend = 'webgpu';
        reason = undefined;
        adapter = ready.adapter;
        limits = ready.limits;
      } else {
        stop(ready.reason);
      }
    } catch (error) {
      stop(error instanceof Error ? error.message : String(error));
    }
    if (termination) await termination;
  }
  return {
    get backend() { return backend; },
    get reason() { return reason; },
    get adapter() { return adapter; },
    get stats() { return { ...counts }; },
    scaleImage(memory, inputOffset, outputOffset, width, height, targetWidth, targetHeight) {
      counts.attempted++;
      const decline = () => { counts.declined++; return false; };
      if (backend !== 'webgpu') return decline();
      const layout = scaleLayout(width, height, targetWidth, targetHeight, maxGpuBytes);
      if (!layout || !(memory instanceof SharedArrayBuffer || memory instanceof ArrayBuffer)) return decline();
      for (const [offset, length] of [[inputOffset, layout.inputBytes], [outputOffset, layout.outputBytes]]) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > memory.byteLength) return decline();
      }
      if (Math.max(layout.inputBytes, layout.intermediateBytes, layout.outputBytes) > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)
        || Math.max(Math.ceil(targetWidth / 8), Math.ceil(height / 8)) > limits.maxComputeWorkgroupsPerDimension) return decline();
      try {
        const input = new SharedArrayBuffer(layout.inputBytes);
        const output = new SharedArrayBuffer(layout.outputBytes);
        const control = new SharedArrayBuffer(4);
        const state = new Int32Array(control);
        new Uint8Array(input).set(new Uint8Array(memory, inputOffset, layout.inputBytes));
        worker.postMessage({ layout, input, output, control });
        const wait = Atomics.wait(state, 0, 0, timeoutMs);
        if (wait === 'timed-out' || Atomics.load(state, 0) !== 1) {
          counts.failed++;
          stop(wait === 'timed-out' ? 'WebGPU scaling timed out.' : 'WebGPU scaling failed.');
          return false;
        }
        // Only this caller can write WASM memory; a late GPU result stays in private staging.
        new Uint8Array(memory, outputOffset, layout.outputBytes).set(new Uint8Array(output));
        counts.accelerated++;
        return true;
      } catch (error) {
        counts.failed++;
        stop(error instanceof Error ? error.message : String(error));
        return false;
      }
    },
    async dispose() {
      stop('GPU scaler is disposed.');
      if (termination) await termination;
      if (terminationError) throw terminationError;
    },
  };
}
