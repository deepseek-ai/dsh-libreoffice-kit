import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { pruneNativePayload, stripNativePayload } from '../scripts/slim-native.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'office-slim-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  for (const part of ['bin', 'program']) mkdirSync(join(directory, part));
  const put = (file, bytes = 'fixture') => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), bytes);
  };
  return { directory, put };
}

for (const platform of ['darwin-arm64', 'linux-arm64-glibc']) test(`${platform} trims desktop assets while retaining conversion resources and notices`, t => {
  const { directory, put } = fixture(t);
  const program = platform.startsWith('darwin-') ? 'program/Office.app/Contents/Frameworks' : 'program/program';
  const resources = `${dirname(program)}/${platform.startsWith('darwin-') ? 'Resources' : 'share'}`;
  const desktop = ['gallery/picture.svg', 'template/blank.ott', 'wizards/index.py', 'tipoftheday/tips.txt', 'config/images_colibre.zip', 'config/images.zip', 'main.icns', 'intro-highres.png'];
  const runtime = ['config/soffice.cfg/settings.xml', 'registry/writer.xcd', 'filter/ooxml.xcu', 'fonts/font.ttf', 'liblangtag/language.xml', 'LICENSE', 'NOTICE'];
  const launcher = platform.startsWith('darwin-') ? `${dirname(program)}/MacOS/soffice` : `${program}/soffice.bin`;
  put(launcher);
  for (const name of [...desktop, ...runtime]) put(`${resources}/${name}`);
  put(`${program}/library`, 'library');
  const result = pruneNativePayload(directory, platform, program);
  assert.equal(result.removedBytes, (desktop.length + 1) * 7);
  assert.equal(existsSync(join(directory, launcher)), false);
  for (const name of desktop) assert.equal(existsSync(join(directory, resources, name)), false, name);
  for (const name of runtime) assert.equal(readFileSync(join(directory, resources, name), 'utf8'), 'fixture', name);
  assert.equal(pruneNativePayload(directory, platform, program).removedBytes, 0);
});

test('macOS removes a byte-identical build alias and rejects an alias with different library bytes', t => {
  const { directory, put } = fixture(t);
  const program = 'program/Office.app/Contents/Frameworks';
  const alias = 'program/Office.app/Contents/MacOS/urelibs';
  put(`${program}/lib.dylib`, 'runtime');
  put(`${alias}/lib.dylib`, 'different');
  assert.throws(() => pruneNativePayload(directory, 'darwin-x64', program), /alias differs/);
  assert.equal(existsSync(join(directory, alias)), true);
  put(`${alias}/lib.dylib`, 'runtime');
  assert.deepEqual(pruneNativePayload(directory, 'darwin-x64', program), { removed: [alias], removedBytes: 7 });
  assert.equal(readFileSync(join(directory, program, 'lib.dylib'), 'utf8'), 'runtime');
});

test('symbol cleanup retains dynamic exports, signs macOS files, and checks the resulting signature', t => {
  const { directory, put } = fixture(t);
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0xfeedfacf);
  put('bin/worker', binary); put('program/lib.dylib', binary); put('program/data', 'unchanged');
  const calls = [];
  const result = stripNativePayload(directory, 'darwin-arm64', (command, args) => {
    calls.push([command, args.slice(0, -1)]);
    if (command === 'strip') writeFileSync(args.at(-1), binary.subarray(0, 32));
  });
  assert.deepEqual(calls, Array.from({ length: 2 }, () => [
    ['strip', ['-S', '-x']], ['codesign', ['--force', '--sign', '-', '--timestamp=none']], ['codesign', ['--verify']],
  ]).flat());
  assert.deepEqual(result, { stripped: ['bin/worker', 'program/lib.dylib'], beforeBytes: 128, afterBytes: 64 });
  assert.equal(readFileSync(join(directory, 'program/data'), 'utf8'), 'unchanged');
  assert.throws(() => stripNativePayload(directory, 'darwin-arm64', () => { throw new Error('strip failed'); }), /strip failed/);
});

test('Linux strips executables and Core libraries but retains authenticated runtime and NSS check files', t => {
  const { directory, put } = fixture(t);
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0x464c457f);
  for (const file of ['bin/worker', 'program/core.so', 'program/libnss3.so', 'program/libsoftokn3.so']) put(file, binary);
  put('program/libsoftokn3.chk', 'checksum');
  put('sources/linux-runtime/receipt.json', JSON.stringify({ packages: [{ files: [{ name: 'libnss3.so' }] }] }));
  const calls = [];
  const result = stripNativePayload(directory, 'linux-arm64-glibc', (command, args) => calls.push([command, args]));
  assert.deepEqual(result.stripped, ['bin/worker', 'program/core.so']);
  assert.ok(calls.every(([command, args]) => command === 'strip' && args[0] === '--strip-unneeded'));
  assert.equal(readFileSync(join(directory, 'program/libnss3.so')).length, 64);
  assert.equal(readFileSync(join(directory, 'program/libsoftokn3.so')).length, 64);
});

test('staging removes developer SDK tools while retaining runtime resources', t => {
  const { directory, put } = fixture(t);
  put('program/LibreOfficeDev26.8_SDK/bin/cppumaker', 'sdk tool');
  put('program/LibreOfficeDev.app/Contents/Frameworks/libuno.dylib', 'runtime');
  const result = pruneNativePayload(directory, 'darwin-arm64', 'program/LibreOfficeDev.app/Contents/Frameworks');
  assert.deepEqual(result.removed, ['program/LibreOfficeDev26.8_SDK']);
  assert.equal(result.removedBytes, 8);
  assert.ok(existsSync(join(directory, 'program/LibreOfficeDev.app/Contents/Frameworks/libuno.dylib')));
});
