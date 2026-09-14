import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { appleDoubleFixture, npmFixture, npmDirectoryFixture } from './archive-fixture.mjs';
import { packEngineArchive, materializeEngineArchive, verifyEngineArchiveRecord } from '../scripts/engine-archive.mjs';
import { npm, run } from '../scripts/pack-utils.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';

function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), 'kit-xz-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true, maxRetries: 3 }));
  const packageDir = join(work, 'package');
  mkdirSync(packageDir);
  const manifest = { name: '@deepseek-ai/libreoffice-kit-fixture', version: '1.0.0', files: ['worker'] };
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(packageDir, 'worker'), 'fixture engine\n');
  chmodSync(join(packageDir, 'worker'), 0o755);
  const gzip = join(work, 'fixture.tgz');
  writeFileSync(gzip, npmDirectoryFixture(packageDir));
  const record = { ...manifest, ...packEngineArchive(gzip, work, manifest) };
  return { work, record };
}

test('XZ transfers restore exact npm tar bytes and install without hooks or a registry', t => {
  const { work, record } = fixture(t);
  const tar = materializeEngineArchive(work, record, join(work, 'prepared'));
  assert.equal(sha256(tar), record.install.sha256);
  assert.equal(statSync(tar).size, record.install.bytes);
  const consumer = join(work, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { [record.name]: `file:${tar}` } }));
  npm(['install', '--offline', '--ignore-scripts', '--package-lock=false'], consumer, work);
  const installed = join(consumer, 'node_modules', record.name, 'worker');
  assert.equal(readFileSync(installed, 'utf8'), 'fixture engine\n');
  if (process.platform !== 'win32') assert.equal(statSync(installed).mode & 0o777, 0o755);
});

test('XZ preparation rejects changed transfers and mismatched inner hashes without keeping partial tar files', t => {
  const { work, record } = fixture(t);
  const destination = join(work, 'prepared');
  assert.throws(() => materializeEngineArchive(work, { ...record, install: { ...record.install, sha256: '0'.repeat(64) } }, destination), /install tar integrity/);
  assert.equal(existsSync(join(destination, record.install.file)), false);
  writeFileSync(join(work, record.file), 'changed bytes');
  assert.throws(() => materializeEngineArchive(work, record, destination), /transfer integrity/);
});

test('XZ envelopes reject extra members and noncanonical filenames', t => {
  const { work, record } = fixture(t);
  writeFileSync(join(work, 'package.tar'), 'tar bytes');
  writeFileSync(join(work, 'extra'), 'extra');
  run('tar', ['-cJf', join(work, record.file), '-C', work, 'package.tar', 'extra']);
  record.bytes = statSync(join(work, record.file)).size;
  record.sha256 = sha256(join(work, record.file));
  assert.throws(() => materializeEngineArchive(work, record, join(work, 'prepared')), /only package.tar/);
  assert.throws(() => verifyEngineArchiveRecord({ ...record, file: '../escape.tar.xz' }), /transfer filename/);
  assert.throws(() => verifyEngineArchiveRecord({ ...record, install: { ...record.install, file: '../escape.tar' } }), /install filename/);
  assert.throws(() => verifyEngineArchiveRecord({ ...record, bytes: 0 }), /archive integrity/);
});


test('XZ envelopes have anonymous ownership and deterministic bytes across pack directories', t => {
  const first = fixture(t);
  const second = fixture(t);
  assert.equal(first.record.sha256, second.record.sha256);
  assert.equal(run('tar', ['-tf', join(first.work, first.record.file)]).trim(), 'package.tar');
  assert.match(run('tar', ['-tvf', join(first.work, first.record.file)]), /^-\S+\s+(?:0\/0\s+|\d+\s+0\s+0\s+)/);
  const file = join(first.work, 'private.tgz');
  writeFileSync(file, npmFixture({ name: first.record.name, version: first.record.version }, {}, { uid: 501, uname: 'private-builder' }));
  assert.throws(() => packEngineArchive(file, first.work, first.record), /ownership/);
});

test('npm preparation discards legacy outer ownership and AppleDouble but preserves exact inner bytes', t => {
  const { work, record } = fixture(t);
  const source = materializeEngineArchive(work, record, join(work, 'original'));
  writeFileSync(join(work, 'package.tar'), readFileSync(source));
  writeFileSync(join(work, '._package.tar'), appleDoubleFixture());
  const ownership = process.platform === 'linux' ? ['--owner=501', '--group=20'] : ['--uid=501', '--gid=20'];
  run('tar', ['--format=ustar', '--no-xattrs', '--no-acls', ...ownership, '-cJf', join(work, record.file), '-C', work, '._package.tar', 'package.tar'],
    { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  record.bytes = statSync(join(work, record.file)).size;
  record.sha256 = sha256(join(work, record.file));
  assert.throws(() => materializeEngineArchive(work, record, join(work, 'strict')), /only package.tar|ownership/);
  const tar = materializeEngineArchive(work, record, join(work, 'npm'), { requireAnonymousEnvelope: false });
  assert.equal(sha256(tar), record.install.sha256);
  assert.equal(existsSync(join(work, 'npm', '._package.tar')), false);
  const broken = { ...record, install: { ...record.install, sha256: '0'.repeat(64) } };
  assert.throws(() => materializeEngineArchive(work, broken, join(work, 'bad-hash'), { requireAnonymousEnvelope: false }), /install tar integrity/);
  assert.equal(existsSync(join(work, 'bad-hash', record.install.file)), false);

  writeFileSync(join(work, 'extra'), 'unexpected');
  run('tar', ['-cJf', join(work, record.file), '-C', work, 'package.tar', 'extra']);
  record.bytes = statSync(join(work, record.file)).size;
  record.sha256 = sha256(join(work, record.file));
  assert.throws(() => materializeEngineArchive(work, record, join(work, 'extra'), { requireAnonymousEnvelope: false }), /only package.tar/);
});
