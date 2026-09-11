import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { mergeWebGL } from '../scripts/merge-webgl.mjs';
import { readJson, root } from '../scripts/platform-matrix.mjs';
import { sha256, verifyGraphicsOverlay } from '../scripts/verify-artifacts.mjs';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'libreoffice-webgl-overlay-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}
function save(dir, prebuild) { writeFileSync(join(dir, 'prebuilds.json'), JSON.stringify(prebuild)); }
function file(dir, prebuild, name, content, executable = false) {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), content);
  if (executable) chmodSync(join(dir, name), 0o755);
  prebuild.files[name] = sha256(join(dir, name));
}
function overlay(t, platform = 'linux-x64') {
  const dir = scratch(t);
  const assets = `assets/graphics/${platform}`;
  const sources = `sources/graphics/${platform}`;
  const licenses = `licenses/graphics/${platform}`;
  const graphics = { status: 'built', binding: `${assets}/nodejs_gl_binding.node`, libraries: [`${assets}/libEGL.so`, `${assets}/libGLESv2.so`], sourceFiles: [`${sources}/build.json`], receipt: `${sources}/build.json` };
  const prebuild = { schemaVersion: 1, version: '0.1.0', files: {}, source: { files: graphics.sourceFiles }, licenses: [], graphics: { [platform]: graphics } };
  // A complete ELF program table for the packaging parser; this fixture is never loaded as an addon.
  const image = Buffer.alloc(128);
  image.writeUInt32LE(0x464c457f, 0); image[4] = 2; image[5] = 1;
  image.writeUInt16LE(3, 16); image.writeUInt16LE(platform.endsWith('x64') ? 62 : 183, 18);
  image.writeBigUInt64LE(64n, 32); image.writeUInt16LE(56, 54); image.writeUInt16LE(1, 56);
  image.writeUInt32LE(1, 64); image.writeUInt32LE(1, 68); image.writeBigUInt64LE(120n, 72); image.writeBigUInt64LE(8n, 96);
  for (const name of [graphics.binding, ...graphics.libraries]) file(dir, prebuild, name, image, true);
  file(dir, prebuild, graphics.receipt, '{}');
  for (const [component, spdx] of [['ANGLE', 'BSD-3-Clause'], ['node-gles-webgl2', 'Apache-2.0']]) {
    const path = `${licenses}/${component}.txt`;
    file(dir, prebuild, path, 'Packaging fixture license');
    prebuild.licenses.push({ component, spdx, path });
  }
  save(dir, prebuild);
  return { dir, prebuild, graphics };
}
function wasm(t) {
  const dir = scratch(t);
  const manifest = readJson(join(root, 'packages/wasm/package.json'));
  const prebuild = { schemaVersion: 1, version: manifest.version, platform: 'wasm', status: 'built',
    engine: readJson(join(root, 'packages/wasm/prebuilds.json')).engine,
    files: {}, source: { repository: 'https://example.com/packaging-fixture', revision: '1'.repeat(40), version: 'fixture', files: ['sources/build.txt'] },
    licenses: [{ component: 'LibreOffice', spdx: 'MPL-2.0', path: 'licenses/LibreOffice.txt' }] };
  // One empty function exported under the eight required names; only the package verifier executes here.
  file(dir, prebuild, 'assets/soffice.wasm', Buffer.from('AGFzbQEAAAABBAFgAAADAgEAB5cBCBJkc2hfbG9rX2luaXRpYWxpemUAABVkc2hfbG9rX2RvY3VtZW50X2xvYWQAABlkc2hfbG9rX2RvY3VtZW50X3NhdmVfcGRmAAAYZHNoX2xva19kb2N1bWVudF9kZXN0cm95AAAPZHNoX2xva19kZXN0cm95AAANZHNoX2xva19lcnJvcgAABm1hbGxvYwAABGZyZWUAAAoEAQIACw==', 'base64'));
  file(dir, prebuild, 'assets/soffice.cjs', 'module.exports = () => {};');
  file(dir, prebuild, 'assets/soffice.data', 'x');
  file(dir, prebuild, 'assets/soffice.data.js.metadata', JSON.stringify({ files: [{ filename: '/instdir/program/resource', start: 0, end: 1 }] }));
  file(dir, prebuild, 'sources/build.txt', 'Packaging fixture');
  file(dir, prebuild, 'licenses/LibreOffice.txt', 'Packaging fixture license');
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  save(dir, prebuild);
  return { dir, prebuild };
}

test('graphics-only overlays merge while preserving the sole WASM base byte for byte', t => {
  const base = wasm(t);
  const sources = [overlay(t), overlay(t, 'linux-arm64')];
  for (const source of sources) assert.equal(verifyGraphicsOverlay(source.dir).files, 6);
  const out = join(scratch(t), 'merged');
  assert.equal(mergeWebGL(out, base.dir, sources.map(source => source.dir)).platform, 'wasm');
  const merged = readJson(join(out, 'prebuilds.json'));
  assert.deepEqual(Object.keys(merged.graphics).sort(), ['linux-arm64', 'linux-x64']);
  for (const path of Object.keys(base.prebuild.files)) assert.deepEqual(readFileSync(join(out, path)), readFileSync(join(base.dir, path)));
  assert.deepEqual(readFileSync(join(out, 'package.json')), readFileSync(join(base.dir, 'package.json')));
  assert.throws(() => mergeWebGL(out, base.dir, [sources[0].dir]), /new destination/);
});

test('merge rejects duplicate platforms and incompatible versions before creating output', t => {
  const base = wasm(t);
  const source = overlay(t);
  const out = join(scratch(t), 'merged');
  assert.throws(() => mergeWebGL(out, base.dir, [source.dir, source.dir]), /Duplicate graphics platform/);
  assert.equal(existsSync(out), false);
  source.prebuild.version = '0.2.0'; save(source.dir, source.prebuild);
  assert.throws(() => mergeWebGL(out, base.dir, [source.dir]), /versions differ/);
  assert.equal(existsSync(out), false);
});

test('merge rejects a base that already contains graphics', t => {
  const base = wasm(t);
  const source = overlay(t);
  const merged = join(scratch(t), 'merged');
  mergeWebGL(merged, base.dir, [source.dir]);
  assert.throws(() => mergeWebGL(join(scratch(t), 'second'), merged, [source.dir]), /without graphics/);
});

for (const [name, mutate, expected] of [
  ['wrong architecture', ({ dir, prebuild, graphics }) => {
    const image = readFileSync(join(dir, graphics.binding)); image.writeUInt16LE(183, 18);
    file(dir, prebuild, graphics.binding, image, true);
  }, /Wrong ELF architecture/],
  ['changed bytes', ({ dir, graphics }) => writeFileSync(join(dir, graphics.binding), 'corrupt'), /checksum mismatch/],
  ['undeclared file', ({ dir }) => writeFileSync(join(dir, 'extra'), 'unexpected'), /inventory/],
  ['WASM bytes in an overlay', ({ prebuild }) => { prebuild.files['assets/soffice.wasm'] = '0'.repeat(64); }, /Invalid overlay file/],
  ['path traversal', ({ prebuild }) => { prebuild.files['assets/graphics/linux-x64/../../escape'] = '0'.repeat(64); }, /Unsafe package path/],
  ['missing source inventory', ({ prebuild }) => { prebuild.source.files = []; }, /Missing graphics source/],
  ['missing source hash', ({ prebuild, graphics }) => { delete prebuild.files[graphics.receipt]; }, /Missing hashed overlay source/],
  ['missing license', ({ prebuild }) => { prebuild.licenses = []; }, /Missing graphics license/],
  ['empty license', ({ dir, prebuild }) => file(dir, prebuild, prebuild.licenses[0].path, ''), /Empty license/],
  ['multiple platforms', ({ prebuild, graphics }) => { prebuild.graphics['linux-arm64'] = graphics; }, /exactly one/],
]) test(`overlay rejects ${name}`, t => {
  const source = overlay(t);
  mutate(source); save(source.dir, source.prebuild);
  assert.throws(() => verifyGraphicsOverlay(source.dir), expected);
});

test('overlay rejects symlinked payloads', { skip: process.platform === 'win32' }, t => {
  const source = overlay(t);
  const binding = join(source.dir, source.graphics.binding);
  rmSync(binding);
  symlinkSync('libEGL.so', binding);
  assert.throws(() => verifyGraphicsOverlay(source.dir), /Symlink|Not a regular/);
});
