import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { debianFields, stageLinuxRuntime, verifyInstalledFile, verifyLinuxClosure } from '../scripts/stage-linux-runtime.mjs';
function elf(machine = 183) {
  const bytes = Buffer.alloc(128);
  bytes.writeUInt32LE(0x464c457f); bytes[4] = 2; bytes[5] = 1;
  bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeUInt32LE(5, 68);
  bytes.writeBigUInt64LE(120n, 72); bytes.writeBigUInt64LE(8n, 96);
  return bytes;
}
function fixture(t, platform = 'linux-arm64-glibc') {
  const machine = platform.includes('-arm64-') ? 183 : 62;
  const architecture = machine === 183 ? 'arm64' : 'amd64';
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-linux-libraries-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  const program = join(directory, 'program/program');
  mkdirSync(program, { recursive: true });
  mkdirSync(join(directory, 'licenses'));
  writeFileSync(join(directory, 'licenses/LibreOffice-MPL-2.0.txt'), 'MPL notice fixture\n');
  const native = join(program, 'libsofficeapp.so');
  writeFileSync(native, elf(machine), { mode: 0o755 });
  const files = ['program/program/libsofficeapp.so', 'licenses/LibreOffice-MPL-2.0.txt'];
  const prebuild = { platform, engine: { programDirectory: 'program/program' }, source: { files: [] }, licenses: [], files: Object.fromEntries(files.map(file => [file, sha256(join(directory, file))])) };
  const specs = [
    ['libnss3', ['libfreebl3.so', 'libfreeblpriv3.so', 'libnss3.so', 'libnssckbi.so', 'libnssdbm3.so', 'libnssutil3.so', 'libsmime3.so', 'libsoftokn3.so', 'libssl3.so', 'libfreebl3.chk', 'libfreeblpriv3.chk', 'libnssdbm3.chk', 'libsoftokn3.chk']],
    ['libnspr4', ['libnspr4.so', 'libplc4.so', 'libplds4.so']],
    ['libsqlite3-0', ['libsqlite3.so.0']],
  ];
  const acquired = specs.map(([name, names]) => {
    const folder = join(directory, 'archives', name);
    mkdirSync(folder, { recursive: true });
    const copyright = join(folder, 'copyright');
    writeFileSync(copyright, `${name} copyright notice\n`);
    return { name, version: '1.2.3-1', architecture, source: { name, version: '1.2.3-1', archives: [] }, archive: { url: 'https://example.invalid/library', sha256: 'a'.repeat(64) }, copyright,
      metadata: { 'binary-control.txt': `Package: ${name}\n`, 'apt-metadata.json': '{}\n', 'source.dsc': `Source: ${name}\n` },
      files: names.map(name => {
        const from = join(folder, name);
        writeFileSync(from, name.includes('.so') ? elf(machine) : Buffer.from('NSS check value'), { mode: 0o644 });
        return { name, from, sha256: sha256(from) };
      }) };
  });
  const needed = { 'libsofficeapp.so': ['libnss3.so', 'libnspr4.so'], 'libnss3.so': ['libnssutil3.so', 'libplc4.so', 'libplds4.so'], 'libsoftokn3.so': ['libsqlite3.so.0'], 'libsqlite3.so.0': ['libm.so.6'] };
  const libc = 'libc.so.6';
  const inspect = file => [...(needed[basename(file)] ?? []), libc].map(name => ` 0x0000000000000001 (NEEDED) Shared library: [${name}]`).join('\n');
  const options = { acquire: () => acquired, inspect };
  return { directory, program, prebuild, acquired, inspect, needed, options };
}

test('Debian metadata preserves source versions and rejects ambiguous fields', () => {
  assert.deepEqual(debianFields('Source: nss\nVersion: 2:3.98-1ubuntu0.2\nChecksums-Sha256:\n abc 123 source.tar.gz\n'), { Source: 'nss', Version: '2:3.98-1ubuntu0.2', 'Checksums-Sha256': '\nabc 123 source.tar.gz' });
  assert.throws(() => debianFields('Version: 1\nVersion: 2\n'), /duplicate/);
  assert.throws(() => debianFields('Name: nss\nnot a field\n'), /Invalid/);
});

test('installed runtime bytes must match their exact Debian archive', t => {
  const { directory } = fixture(t);
  const installed = join(directory, 'installed');
  const extracted = join(directory, 'extracted');
  writeFileSync(installed, 'same bytes'); writeFileSync(extracted, 'same bytes');
  assert.equal(verifyInstalledFile(installed, extracted), sha256(extracted));
  writeFileSync(installed, 'locally replaced library');
  assert.throws(() => verifyInstalledFile(installed, extracted), /differs from its Debian archive/);
});

test('glibc staging preserves Core bytes and records all NSS modules, notices and source metadata', t => {
  const { directory, program, prebuild, options } = fixture(t);
  const before = sha256(join(program, 'libsofficeapp.so'));
  stageLinuxRuntime(directory, prebuild, options);
  assert.equal(sha256(join(program, 'libsofficeapp.so')), before);
  const receipt = JSON.parse(readFileSync(join(directory, 'sources/linux-runtime/receipt.json')));
  assert.equal(receipt.packages.length, 3);
  assert.equal(receipt.closure.elfFiles, 14);
  assert.deepEqual(receipt.closure.systemLibraries, ['libc.so.6', 'libm.so.6']);
  assert.ok(prebuild.files['program/program/libsoftokn3.chk']);
  assert.ok(prebuild.files['program/program/libplds4.so']);
  assert.ok(prebuild.files['program/program/libsqlite3.so.0']);
  assert.equal(prebuild.licenses.length, 4);
  for (const record of receipt.packages) for (const file of record.sourceFiles) assert.ok(prebuild.source.files.includes(file));
  const frozen = JSON.stringify(prebuild);
  stageLinuxRuntime(directory, prebuild, { ...options, acquire: () => assert.fail('reuse must preserve its existing runtime package versions') });
  assert.equal(JSON.stringify(prebuild), frozen);
});

for (const missing of ['libsoftokn3.so', 'libsoftokn3.chk', 'libplds4.so', 'libsqlite3.so.0']) test(`staging rejects missing ${missing}`, t => {
  const { directory, prebuild, acquired, options } = fixture(t);
  const item = acquired.find(item => item.files.some(file => file.name === missing));
  item.files = item.files.filter(file => file.name !== missing);
  assert.throws(() => stageLinuxRuntime(directory, prebuild, options), /Invalid Linux runtime package/);
});

test('staging rejects changed bytes, foreign architecture and Core file collisions', t => {
  const f = fixture(t);
  const file = f.acquired[0].files[0];
  writeFileSync(file.from, elf(62));
  assert.throws(() => stageLinuxRuntime(f.directory, f.prebuild, f.options), /changed Linux runtime module/);
  file.sha256 = sha256(file.from);
  assert.throws(() => stageLinuxRuntime(f.directory, f.prebuild, f.options), /Wrong ELF architecture/);
  writeFileSync(file.from, elf()); file.sha256 = sha256(file.from);
  writeFileSync(join(f.program, file.name), 'existing Core bytes');
  assert.throws(() => stageLinuxRuntime(f.directory, f.prebuild, f.options), /collides with existing Core/);
  assert.equal(readFileSync(join(f.program, file.name), 'utf8'), 'existing Core bytes');
});

test('the full ELF closure rejects unbundled and absolute dependencies and foreign Core binaries', t => {
  const f = fixture(t);
  f.needed['libsofficeapp.so'] = ['libunbundled.so'];
  assert.throws(() => verifyLinuxClosure(f.directory, f.prebuild, f.inspect), /Unbundled Linux runtime dependency/);
  f.needed['libsofficeapp.so'] = ['/builder/libnss3.so'];
  assert.throws(() => verifyLinuxClosure(f.directory, f.prebuild, f.inspect), /Absolute or relative ELF dependency/);
  writeFileSync(join(f.program, 'libsofficeapp.so'), elf(62));
  assert.throws(() => verifyLinuxClosure(f.directory, f.prebuild, f.inspect), /Foreign ELF architecture/);
});

test('reuse refuses missing or rehashed runtime modules', t => {
  const f = fixture(t);
  stageLinuxRuntime(f.directory, f.prebuild, f.options);
  const file = 'program/program/libsoftokn3.chk';
  writeFileSync(join(f.directory, file), 'tampered');
  assert.throws(() => stageLinuxRuntime(f.directory, f.prebuild, f.options), /module receipt mismatch/);
  f.prebuild.files[file] = sha256(join(f.directory, file));
  assert.throws(() => stageLinuxRuntime(f.directory, f.prebuild, f.options), /module receipt mismatch/);
});

test('other platforms do not acquire Debian libraries', () => {
  for (const platform of ['darwin-arm64', 'win32-x64']) stageLinuxRuntime('/unused', { platform }, { acquire: () => assert.fail('not a Linux package') });
});

for (const platform of ['linux-arm64-glibc', 'linux-x64-glibc']) test(`static ${platform} validates its closure without restoring NSS`, t => {
  const f = fixture(t, platform);
  f.needed['libsofficeapp.so'] = ['libstdc++.so.6', 'libgcc_s.so.1'];
  const options = { ...f.options, staticLibraries: true, acquire: () => assert.fail('static Core must not acquire NSS') };
  const before = JSON.stringify(f.prebuild);
  stageLinuxRuntime(f.directory, f.prebuild, options);
  assert.equal(JSON.stringify(f.prebuild), before);
  f.needed['libsofficeapp.so'].push('libnss3.so');
  assert.throws(() => stageLinuxRuntime(f.directory, f.prebuild, options), /Unbundled Linux runtime dependency/);
});
