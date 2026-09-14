import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { packEngineArchive, materializeEngineArchive, verifyEngineArchiveRecord } from '../scripts/engine-archive.mjs';
import { npm, run } from '../scripts/pack-utils.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';

function fixture(t) {
  const work = mkdtempSync(join(tmpdir(), 'kit-xz-test-'));
  t.after(() => rmSync(work, { recursive: true, force: true, maxRetries: 3 }));
  const packageDir = join(work, 'package');
  mkdirSync(packageDir);
  const manifest = { name: '@deepseek-ai/dsh-libreoffice-kit-fixture', version: '1.0.0', files: ['worker'] };
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(packageDir, 'worker'), 'fixture engine\n');
  chmodSync(join(packageDir, 'worker'), 0o755);
  const gzip = join(work, 'fixture.tgz');
  run('tar', ['-czf', gzip, '-C', work, 'package']);
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
