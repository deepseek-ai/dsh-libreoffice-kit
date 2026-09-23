/** Diagnostic-only accounting of original font bytes returned by synchronous Worker reads. */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { parentPort } from 'node:worker_threads';

const descriptors = new Set();
const open = fs.openSync, read = fs.readSync, close = fs.closeSync;
let bytes = 0, calls = 0, metadataInspectCalls = 0;
fs.openSync = function(path, ...args) {
  const fd = open.call(this, path, ...args);
  if (/\.(ttf|otf|ttc|otc|dfont)$/i.test(String(path))) {
    descriptors.add(fd);
    if (/\bat inspect \(/.test(new Error().stack)) metadataInspectCalls++;
  }
  return fd;
};
fs.readSync = function(fd, ...args) {
  const count = read.call(this, fd, ...args);
  if (descriptors.has(fd)) { bytes += count; calls++; }
  return count;
};
fs.closeSync = function(fd) { descriptors.delete(fd); return close.call(this, fd); };
syncBuiltinESMExports();
if (parentPort) {
  const post = parentPort.postMessage;
  parentPort.postMessage = function(message, ...args) {
    return post.call(this, { ...message, benchmarkFontReads: { bytes, calls, metadataInspectCalls } }, ...args);
  };
}
