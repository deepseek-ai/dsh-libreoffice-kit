import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { glibcMinimum, neededGlibcVersions } from '../engine/native/glibc-minimum.mjs';

test('only glibc version-needs records contribute to the floor', () => {
  const output = `Version symbols section '.gnu.version' contains 3 entries:
  000: 2 (GLIBC_2.99)
Version definition section '.gnu.version_d' contains 2 entries:
  0x0000: Rev: 1  Flags: BASE  Index: 1  Cnt: 1  Name: GLIBC_2.99
Version needs section '.gnu.version_r' contains 2 entries:
  0x0000: Version: 1  File: libc.so.6  Cnt: 2
  0x0010:   Name: GLIBC_2.2.5  Flags: none  Version: 3
  0x0020:   Name: GLIBC_2.38  Flags: none  Version: 4
  0x0030: Version: 1  File: libstdc++.so.6  Cnt: 1
  0x0040:   Name: GLIBCXX_3.4.32  Flags: none  Version: 5
Version definition section '.gnu.version_d' contains 1 entry:
  0x0000: Rev: 1  Flags: none  Index: 1  Cnt: 1  Name: GLIBC_9.0
`;
  assert.deepEqual(neededGlibcVersions(output), ['2.2.5', '2.38']);
});

test('DT_RELR requires glibc 2.36 and unknown glibc capability requirements reject', () => {
  const needs = tag => `Version needs section '.gnu.version_r' contains 1 entry:\n  0x0010: Name: ${tag}  Flags: none  Version: 3\n`;
  assert.deepEqual(neededGlibcVersions(needs('GLIBC_ABI_DT_RELR')), ['2.36']);
  for (const tag of ['GLIBC_PRIVATE', 'GLIBC_ABI_UNKNOWN', 'GLIBC_2.invalid']) assert.throws(() => neededGlibcVersions(needs(tag)), /Unsupported glibc version requirement/);
});

test('a payload without ELF glibc requirements cannot invent a minimum', t => {
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-glibc-scan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'program'));
  writeFileSync(join(directory, 'program/resource'), 'resource');
  assert.throws(() => glibcMinimum(directory, ['program/resource']), /No glibc version requirements/);
  assert.throws(() => glibcMinimum(directory, ['program/../outside']), /Unsafe package path/);
});

test('the scanner includes bundled ELF requirements, compares numerically, and refuses tool failures', { skip: process.platform === 'win32' }, t => {
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-glibc-tool-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'bin'));
  mkdirSync(join(directory, 'program'));
  const files = ['bin/helper', 'program/dependency.so'];
  for (const file of files) writeFileSync(join(directory, file), Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  const readelf = join(directory, 'readelf');
  writeFileSync(readelf, `#!/bin/sh
case "$3" in */helper) version=2.9 ;; *) version=2.38 ;; esac
printf "Version definition section '.gnu.version_d' contains 1 entry:\\n Name: GLIBC_9.0\\nVersion needs section '.gnu.version_r' contains 1 entry:\\n Name: GLIBC_%s  Flags: none\\n" "$version"
`);
  chmodSync(readelf, 0o755);
  assert.equal(glibcMinimum(directory, files, { readelf }), '2.38');
  writeFileSync(readelf, '#!/bin/sh\nexit 7\n');
  assert.throws(() => glibcMinimum(directory, files, { readelf }), /readelf failed for bin\/helper/);
});
