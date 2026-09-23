/** Exercise real fontkit containers without adding font binaries to the repository. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const directory = resolve(process.argv[2]);
let bytes = 0;
const descriptors = new Set(), open = fs.openSync, read = fs.readSync, close = fs.closeSync;
fs.openSync = function(path, ...args) {
  const fd = open.call(this, path, ...args);
  if (/\.(ttf|otf|ttc|otc|dfont)$/i.test(String(path))) descriptors.add(fd);
  return fd;
};
fs.readSync = function(fd, ...args) { const count = read.call(this, fd, ...args); if (descriptors.has(fd)) bytes += count; return count; };
fs.closeSync = function(fd) { descriptors.delete(fd); return close.call(this, fd); };
syncBuiltinESMExports();
const { scanFontSnapshot } = await import('../packages/entry/lib/types/font-snapshot.js');
const { writeFontMetadataCache } = await import('../packages/entry/lib/types/font-metadata-cache.js');
const { resolveOptions } = await import('../packages/entry/lib/types/options.js');
const { SystemFontCatalog } = await import('../packages/entry/lib/types/fonts.js');
const cache = await mkdtemp(join(tmpdir(), 'kit-format-cache-'));
try {
  const options = resolveOptions({ fontDirectories: [directory], fontMetadataCacheDirectory: cache });
  const cold = scanFontSnapshot(options), coldBytes = bytes;
  const formats = Object.fromEntries(['.ttf', '.otf', '.ttc', '.otc', '.dfont'].map(extension => {
    const files = cold.records.filter(record => extname(record.path).toLowerCase() === extension);
    assert.ok(files.length > 0 && files.every(record => record.faces.length > 0), `Missing readable ${extension} fixture.`);
    return [extension, { files: files.length, faces: files.reduce((sum, file) => sum + file.faces.length, 0) }];
  }));
  writeFontMetadataCache(options, cold.records, join(cache, '.owned'));
  bytes = 0; const disk = scanFontSnapshot(options); assert.equal(bytes, 0);
  const memory = scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false }, cold.records); assert.equal(bytes, 0);
  assert.deepEqual(disk, cold); assert.deepEqual(memory, cold);
  const match = snapshot => {
    const catalog = new SystemFontCatalog({ faces: snapshot.faces, fallbackFamilies: [] });
    return snapshot.faces.map(face => catalog.match({ family: face.family, style: '', weight: 5, italic: 0,
      width: 5, pitch: 0, language: '', codePoints: [65, 0x4e2d, 0x10ffff] }, new AbortController().signal));
  };
  assert.deepEqual(match(disk), match(cold)); assert.deepEqual(match(memory), match(cold));
  console.log(JSON.stringify({ formats, coldFontReadBytes: coldBytes, diskFontReadBytes: 0, memoryFontReadBytes: 0, metadataAndMatchingEqual: true }, null, 2));
} finally { await rm(cache, { recursive: true, force: true }); }
