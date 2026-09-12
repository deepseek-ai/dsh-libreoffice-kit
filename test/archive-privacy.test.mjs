import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { archiveOwnerOptions, run } from '../scripts/pack-utils.mjs';

test('engine archives preserve executable mode without account ownership or extended attributes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'kit-archive-privacy-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'helper'), 'synthetic executable fixture\n', { mode: 0o755 });
  const output = join(directory, 'payload.tar.gz');
  run('tar', [...archiveOwnerOptions(), '-czf', output, '-C', directory, 'helper'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const tar = gunzipSync(readFileSync(output));
  const field = (start, size) => tar.subarray(start, start + size).toString().replace(/\0.*$/s, '').trim();
  assert.equal(field(0, 100), 'helper');
  if (process.platform !== 'win32') assert.equal(parseInt(field(100, 8), 8) & 0o777, 0o755);
  assert.equal(parseInt(field(108, 8), 8), 0);
  assert.equal(parseInt(field(116, 8), 8), 0);
  assert.equal(field(265, 32), '');
  assert.equal(field(297, 32), '');
  assert.equal(tar.subarray(512, 541).toString().replace(/\0.*$/s, ''), 'synthetic executable fixture\n');
});
