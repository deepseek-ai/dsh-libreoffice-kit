import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { downloadChecksums, verifyCachedDownloads } from '../scripts/verify-cached-downloads.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('reuses valid archives, drops corrupt cache entries and leaves unrelated cache data alone', t => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-download-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const list = join(dir, 'download.lst');
  writeFileSync(list, `A_VERSION := 1\nA_TARBALL := a-$(A_VERSION).tar.gz\nA_SHA256SUM := ${digest('valid')}\nB_TARBALL := b.zip\nB_SHA256SUM := ${digest('new')}\nC_TARBALL := absent.tar\nC_SHA256SUM := ${digest('absent')}\n`);
  writeFileSync(join(dir, 'a-1.tar.gz'), 'valid');
  writeFileSync(join(dir, 'b.zip'), 'old or partial');
  writeFileSync(join(dir, 'unrelated.tar'), 'other version');
  assert.deepEqual(verifyCachedDownloads(list, dir), { verified: 1, removed: ['b.zip'] });
  assert.equal(existsSync(join(dir, 'b.zip')), false);
  assert.equal(readFileSync(join(dir, 'unrelated.tar'), 'utf8'), 'other version');
  assert.deepEqual(verifyCachedDownloads(list, dir), { verified: 1, removed: [] });
});

test('does not follow a cached archive symlink or accept paths and unresolved make variables', t => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-download-symlink-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'outside'), 'keep');
  symlinkSync(join(dir, 'outside'), join(dir, 'archive'));
  const list = join(dir, 'download.lst');
  writeFileSync(list, `A_TARBALL := archive\nA_SHA256SUM := ${digest('keep')}\n`);
  assert.deepEqual(verifyCachedDownloads(list, dir), { verified: 0, removed: ['archive'] });
  assert.equal(readFileSync(join(dir, 'outside'), 'utf8'), 'keep');
  for (const file of ['../outside', '$(UNKNOWN)', '$(A_TARBALL)'])
    assert.throws(() => downloadChecksums(`A_TARBALL := ${file}\nA_SHA256SUM := ${digest('keep')}\n`), /Invalid download/);
});
