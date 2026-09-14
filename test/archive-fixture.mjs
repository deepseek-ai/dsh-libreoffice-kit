/** Small USTAR fixtures with explicit ownership, without host tar defaults. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export function tarFixture(files, { uid = 0, uname = '' } = {}) {
  const chunks = [];
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const header = Buffer.alloc(512);
    const put = (offset, text) => header.write(text, offset, 'utf8');
    const octal = (offset, width, value) => put(offset, value.toString(8).padStart(width - 1, '0') + '\0');
    const slash = name.lastIndexOf('/');
    if (Buffer.byteLength(name) > 100) {
      put(0, name.slice(slash + 1));
      put(345, name.slice(0, slash));
    } else put(0, name);
    octal(100, 8, 0o755); octal(108, 8, uid); octal(116, 8, 0);
    octal(124, 12, data.length); octal(136, 12, 0);
    put(148, '        '); put(156, '0'); put(257, 'ustar\0'); put(263, '00'); put(265, uname);
    put(148, header.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ');
    chunks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}

export function npmFixture(manifest, files = {}, metadata) {
  return gzipSync(tarFixture({ 'package/package.json': JSON.stringify(manifest), ...files }, metadata));
}

/** AppleDouble v2 with one empty Finder Info entry, without host metadata. */
export function appleDoubleFixture() {
  const bytes = Buffer.alloc(70);
  bytes.writeUInt32BE(0x00051607, 0);
  bytes.writeUInt32BE(0x00020000, 4);
  bytes.writeUInt16BE(1, 24);
  bytes.writeUInt32BE(9, 26);
  bytes.writeUInt32BE(38, 30);
  bytes.writeUInt32BE(32, 34);
  return bytes;
}

export function npmDirectoryFixture(directory) {
  const files = {};
  function visit(prefix = '') {
    for (const item of readdirSync(join(directory, prefix), { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isDirectory()) visit(name + '/');
      else files['package/' + name] = readFileSync(join(directory, name));
    }
  }
  visit();
  return gzipSync(tarFixture(files));
}
