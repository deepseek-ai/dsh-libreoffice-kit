/** A real worker exercises the blocking side without ever blocking the test runner. */
import { parentPort, workerData } from 'node:worker_threads';
import { createFontReader } from '../src/font-channel.ts';
const installed = [];
const read = createFontReader(workerData.channel, workerData.timeoutMs, workerData.limit, new Map([['test', 'Test']]),
  (request, known) => parentPort.postMessage({ type: 'font', request, known }),
  () => parentPort.postMessage({ type: 'next' }),
  (path, bytes) => installed.push({ path, length: bytes.length, first: bytes[0], last: bytes.at(-1) }),
  families => parentPort.postMessage({ type: 'missing', families }));
const request = { family: 'Test', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [], ...(workerData.full ? { mode: 'full' } : {}) };
try {
  const paths = read(request);
  const cached = read(request);
  const expanded = workerData.expand ? read({ ...request, family: 'DSH_test', codePoints: [0x0627] }) : undefined;
  const repeated = workerData.repeat ? read({ ...request, family: 'Test Serif' }) : undefined;
  parentPort.postMessage({ type: 'done', paths, cached, installed, ...(expanded ? { expanded } : {}), ...(repeated ? { repeated } : {}) });
} catch (error) {
  parentPort.postMessage({ type: 'failed', name: error.name, code: error.code, message: error.message });
}
