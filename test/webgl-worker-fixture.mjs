/** Each worker loads the native module before the parent releases the creation barrier. */
import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';
import { createWebGlScaler } from '../packages/entry/src/gpu/webgl.mjs';
import { scaleLayout } from '../packages/entry/src/gpu/layout.mjs';
createRequire(import.meta.url)(workerData.binding);
let scaler;
parentPort.on('message', message => {
  if (message === 'dispose') {
    scaler.dispose();
    parentPort.postMessage('disposed');
    parentPort.close();
    return;
  }
  scaler ??= createWebGlScaler(workerData.version);
  const layout = scaleLayout(8, 8, 4, 4, 8192);
  const input = new Uint8Array(layout.inputBytes).fill(workerData.color);
  const output = new ArrayBuffer(layout.outputBytes);
  scaler.scale(layout, input.buffer, output);
  parentPort.postMessage({ pixels: [...new Uint8Array(output)], adapter: scaler.adapter });
});
parentPort.postMessage('ready');
