import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveDependency } from '../scripts/audit-macos.mjs';

test('Mach-O closure permits package-relative libraries and Apple system libraries only', t => {
  const work = mkdtempSync(join(tmpdir(), 'macho-closure-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const root = join(work, 'package');
  mkdirSync(root);
  writeFileSync(join(root, 'owned.dylib'), 'fixture');
  writeFileSync(join(work, 'outside.dylib'), 'fixture');
  const file = join(root, 'helper');
  assert.equal(resolveDependency('@loader_path/owned.dylib', file, file, [], root), 'owned.dylib');
  assert.equal(resolveDependency('@rpath/owned.dylib', file, file, ['@loader_path'], root), 'owned.dylib');
  assert.equal(resolveDependency('/usr/lib/libSystem.B.dylib', file, file, [], root), '/usr/lib/libSystem.B.dylib');
  assert.throws(() => resolveDependency('@loader_path/missing.dylib', file, file, [], root), /Unresolved/);
  assert.throws(() => resolveDependency(join(work, 'outside.dylib'), file, file, [], root), /escapes/);
  assert.throws(() => resolveDependency('/opt/homebrew/lib/unshipped.dylib', file, file, [], root), /Unresolved/);
});
