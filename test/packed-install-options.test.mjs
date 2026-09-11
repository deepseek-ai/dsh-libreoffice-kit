import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hostTarget } from '../scripts/platform-matrix.mjs';
import { sha256 } from '../scripts/verify-artifacts.mjs';
import { verifyPackedInstall } from '../scripts/verify-packed-install.mjs';

const platform = hostTarget();
function fixture(t, platforms, packages) {
  const directory = mkdtempSync(join(tmpdir(), 'libreoffice-install-options-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const records = packages.map(value => {
    const file = `${value}.tgz`;
    writeFileSync(join(directory, file), `untrusted archive for ${value}`);
    return { platform: value, file, sha256: sha256(join(directory, file)) };
  });
  const manifest = { schemaVersion: 1, platforms, packages: records, dependencies: [] };
  writeFileSync(join(directory, 'release.json'), JSON.stringify(manifest));
  return { directory, manifest };
}

test('expecting WASM retains the matching native installation requirement', { skip: !platform }, t => {
  const absent = fixture(t, ['wasm'], ['entry', 'wasm']);
  assert.throws(() => verifyPackedInstall(absent.directory, { expectedBackend: 'wasm' }), /Release lacks host package/);
  const incomplete = fixture(t, [platform, 'wasm'], ['entry', 'wasm']);
  assert.throws(() => verifyPackedInstall(incomplete.directory, { expectedBackend: 'wasm' }), /omits an installed engine/);
});

test('expecting WASM still verifies the installed native tarball checksum', { skip: !platform }, t => {
  const { directory } = fixture(t, [platform, 'wasm'], ['entry', 'wasm', platform]);
  writeFileSync(join(directory, `${platform}.tgz`), 'modified native archive');
  assert.throws(() => verifyPackedInstall(directory, { expectedBackend: 'wasm' }), /Tarball checksum mismatch/);
});
