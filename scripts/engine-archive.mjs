/** XZ transfer envelopes retain an exact npm tar for offline installation. */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { tarballName } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';
import { run } from './pack-utils.mjs';

/** @returns The canonical XZ transfer filename for an engine package. */
export function engineArchiveName(manifest) {
  return tarballName(manifest).replace(/\.tgz$/, '.tar.xz');
}

/** Validate the two archive identities before using either filename on disk. */
export function verifyEngineArchiveRecord(record) {
  assert(record.file === engineArchiveName(record) && record.file === basename(record.file), 'Invalid engine transfer filename');
  assert(record.install?.file === record.file.replace(/\.xz$/, ''), 'Invalid engine install filename');
  for (const item of [record, record.install]) {
    assert(Number.isSafeInteger(item.bytes) && item.bytes > 0 && /^[a-f0-9]{64}$/.test(item.sha256 ?? ''), 'Invalid engine archive integrity');
  }
}

/**
 * Re-encode an npm gzip tar as an XZ envelope containing only package.tar.
 * The inner tar is unchanged and its hash is independent of the host's gzip implementation.
 * @param gzip - npm pack output.
 * @param destination - Directory receiving the XZ envelope.
 * @param manifest - Package name and version.
 * @returns Transfer and installation filenames, byte counts and hashes.
 */
export function packEngineArchive(gzip, destination, manifest) {
  const work = mkdtempSync(join(tmpdir(), 'kit-xz-pack-'));
  try {
    const tar = join(work, 'package.tar');
    writeFileSync(tar, gunzipSync(readFileSync(gzip)), { flag: 'wx' });
    const file = engineArchiveName(manifest);
    const archive = join(destination, file);
    run('tar', ['-cJf', archive, '-C', work, 'package.tar'], { timeout: 900_000 });
    return { file, bytes: statSync(archive).size, sha256: sha256(archive),
      install: { file: file.replace(/\.xz$/, ''), bytes: statSync(tar).size, sha256: sha256(tar) } };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

/**
 * Verify and decode a transfer envelope without extracting its paths into the filesystem.
 * @param directory - Directory holding the downloaded envelope.
 * @param record - Canonical package identity and both archive hashes.
 * @param destination - Private directory receiving the npm tar.
 * @returns The verified npm tar path.
 */
export function materializeEngineArchive(directory, record, destination) {
  verifyEngineArchiveRecord(record);
  const archive = join(directory, record.file);
  assert(statSync(archive).size === record.bytes && sha256(archive) === record.sha256, 'Engine transfer integrity mismatch');
  assert(run('tar', ['-tf', archive]).trim() === 'package.tar', 'Engine transfer must contain only package.tar');
  mkdirSync(destination, { recursive: true });
  const target = join(destination, record.install.file);
  const descriptor = openSync(target, 'wx', 0o600);
  try {
    try { run('tar', ['-xOf', archive, 'package.tar'], { stdio: ['ignore', descriptor, 'pipe'], timeout: 900_000 }); }
    finally { closeSync(descriptor); }
    assert(statSync(target).size === record.install.bytes && sha256(target) === record.install.sha256, 'Engine install tar integrity mismatch');
    return target;
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  }
}
