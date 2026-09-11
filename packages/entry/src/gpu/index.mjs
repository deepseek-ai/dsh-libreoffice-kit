/** Ordered Node GPU selection and the bounded synchronous WASM image callback. */
import { Worker } from 'node:worker_threads';
import { scaleLayout } from './layout.mjs';

const BACKENDS = ['webgpu', 'webgl2', 'webgl1'];

function verifyReady(message, backend) {
  if (message?.backend === 'cpu') throw new Error(message.reason || `${backend} is unavailable.`);
  if (message?.backend !== backend) throw new Error(`${backend} worker returned an unexpected backend.`);
  const keys = backend === 'webgpu'
    ? ['maxBufferSize', 'maxStorageBufferBindingSize', 'maxComputeWorkgroupsPerDimension'] : ['maxTextureSize'];
  for (const key of keys) if (!Number.isSafeInteger(message.limits?.[key]) || message.limits[key] < 1) throw new Error(`${backend} worker returned an invalid ${key}.`);
  return message;
}

/**
 * Try each requested backend in an isolated worker, joining failed attempts before proceeding.
 * Explicit modes attempt one provider; absence returns CPU with the failure reason.
 * A false scaleImage result preserves output and delegates to LibreOffice's CPU filter.
 * Call from the conversion worker: scaleImage blocks its caller for at most timeoutMs.
 * @param {object} options Pixel-memory, operation, and per-provider initialization limits.
 * @returns {Promise<object>} A synchronous scaleImage callback and awaited disposal.
 */
export async function createImageScaler({ maxGpuBytes, timeoutMs, initializationTimeoutMs = timeoutMs, mode = 'auto' }) {
  for (const [name, value] of Object.entries({ maxGpuBytes, timeoutMs, initializationTimeoutMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  }
  if (timeoutMs > 0x7fffffff || initializationTimeoutMs > 0x7fffffff) throw new RangeError('GPU time limits exceed the Node timer range.');
  if (!['auto', 'off', ...BACKENDS].includes(mode)) throw new TypeError('GPU mode must be auto, off, webgpu, webgl2, or webgl1.');
  let selected;
  let backend = 'cpu';
  let reason = 'GPU scaling is disabled.';
  let adapter;
  let limits;
  const counts = { attempted: 0, accelerated: 0, declined: 0, failed: 0 };
  const terminate = attempt => {
    attempt.termination ??= attempt.worker.terminate();
    // Initialization or dispose observes rejection; scaleImage itself must remain synchronous.
    void attempt.termination.catch(() => {});
    return attempt.termination;
  };
  const dispose = attempt => {
    attempt.termination ??= (async () => {
      const worker = attempt.worker;
      try {
        await new Promise((resolve, reject) => {
          const finish = callback => value => {
            clearTimeout(timer);
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
            callback(value);
          };
          const onMessage = message => {
            if (message.kind === 'disposed') finish(resolve)();
            else if (message.kind === 'dispose-error') finish(reject)(new Error(message.reason));
          };
          const onError = finish(reject);
          const onExit = finish(resolve);
          const timer = setTimeout(() => onError(new Error('GPU disposal timed out.')), timeoutMs);
          worker.on('message', onMessage);
          worker.once('error', onError);
          worker.once('exit', onExit);
          worker.postMessage({ kind: 'dispose' });
        });
      } finally { await worker.terminate(); }
    })();
    return attempt.termination;
  };
  const stop = message => {
    backend = 'cpu';
    reason = message;
    if (selected) terminate(selected);
  };
  const failures = [];
  for (const candidate of mode === 'off' ? [] : mode === 'auto' ? BACKENDS : [mode]) {
    let attempt;
    try {
      const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
        name: `libreoffice-image-${candidate}`, workerData: { mode: candidate }, execArgv: [], stdout: true, stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      attempt = { worker };
      worker.on('error', error => { if (selected === attempt && backend !== 'cpu') stop(`${candidate} worker failed: ${error.message}`); });
      worker.on('exit', code => { if (selected === attempt && !attempt.termination) stop(`${candidate} worker exited (${code}).`); });
      const ready = verifyReady(await new Promise((resolve, reject) => {
        const finish = callback => value => {
          clearTimeout(timer);
          worker.off('message', onMessage);
          worker.off('error', onError);
          worker.off('exit', onExit);
          callback(value);
        };
        const onMessage = finish(resolve);
        const onError = finish(reject);
        const onExit = finish(code => reject(new Error(`${candidate} worker exited during initialization (${code}).`)));
        const timer = setTimeout(() => onError(new Error(`${candidate} initialization timed out.`)), initializationTimeoutMs);
        worker.once('message', onMessage);
        worker.once('error', onError);
        worker.once('exit', onExit);
      }), candidate);
      selected = attempt;
      backend = candidate;
      reason = undefined;
      adapter = ready.adapter;
      limits = ready.limits;
      break;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt) await terminate(attempt);
    }
  }
  if (backend === 'cpu' && failures.length) reason = failures.join('; ');
  return {
    get backend() { return backend; },
    get reason() { return reason; },
    get adapter() { return adapter; },
    get stats() { return { ...counts }; },
    scaleImage(memory, inputOffset, outputOffset, width, height, targetWidth, targetHeight) {
      counts.attempted++;
      const decline = () => { counts.declined++; return false; };
      if (backend === 'cpu') return decline();
      const layout = scaleLayout(width, height, targetWidth, targetHeight, maxGpuBytes);
      if (!layout || !(memory instanceof SharedArrayBuffer || memory instanceof ArrayBuffer)) return decline();
      for (const [offset, length] of [[inputOffset, layout.inputBytes], [outputOffset, layout.outputBytes]]) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + length > memory.byteLength) return decline();
      }
      if (backend === 'webgpu') {
        if (Math.max(layout.inputBytes, layout.intermediateBytes, layout.outputBytes) > Math.min(limits.maxBufferSize, limits.maxStorageBufferBindingSize)
          || Math.max(Math.ceil(targetWidth / 8), Math.ceil(height / 8)) > limits.maxComputeWorkgroupsPerDimension) return decline();
      } else if (Math.max(width, height, targetWidth, targetHeight) > limits.maxTextureSize) return decline();
      try {
        const input = new SharedArrayBuffer(layout.inputBytes);
        const output = new SharedArrayBuffer(layout.outputBytes);
        const control = new SharedArrayBuffer(4);
        const state = new Int32Array(control);
        new Uint8Array(input).set(new Uint8Array(memory, inputOffset, layout.inputBytes));
        selected.worker.postMessage({ layout, input, output, control });
        const wait = Atomics.wait(state, 0, 0, timeoutMs);
        if (wait === 'timed-out' || Atomics.load(state, 0) !== 1) {
          counts.failed++;
          stop(wait === 'timed-out' ? `${backend} scaling timed out.` : `${backend} scaling failed.`);
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
      backend = 'cpu';
      reason = 'GPU scaler is disposed.';
      if (selected) await dispose(selected);
    },
  };
}
