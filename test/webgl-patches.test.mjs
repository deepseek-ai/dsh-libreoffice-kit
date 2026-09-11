/** Git checkout must preserve exact patch bytes for npm sources with LF endings. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { root } from '../scripts/platform-matrix.mjs';

test('Windows-style Git checkout retains LF patches; CRLF patches fail exact source matching', () => {
  const work = mkdtempSync(join(tmpdir(), 'webgl-patch-checkout-'));
  const checkout = join(work, 'checkout');
  const source = join(work, 'source');
  const relative = 'engine/webgl/patches/context.patch';
  const patch = '--- a/context.txt\n+++ b/context.txt\n@@ -1,2 +1,2 @@\n before\n-old\n+new\n';
  const git = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  try {
    mkdirSync(join(checkout, 'engine/webgl/patches'), { recursive: true });
    mkdirSync(source);
    copyFileSync(join(root, '.gitattributes'), join(checkout, '.gitattributes'));
    writeFileSync(join(checkout, relative), patch);
    writeFileSync(join(source, 'context.txt'), 'before\nold\n');
    for (const args of [['init', '-q'], ['-c', 'core.autocrlf=true', 'add', '.']]) {
      const result = git(checkout, args);
      assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    }
    rmSync(join(checkout, relative));
    const restored = git(checkout, ['-c', 'core.autocrlf=true', 'checkout-index', '--all']);
    assert.equal(restored.status, 0, restored.error?.message ?? restored.stderr);
    assert.equal(readFileSync(join(checkout, relative), 'utf8'), patch);
    const valid = git(source, ['apply', '--check', join(checkout, relative)]);
    assert.equal(valid.status, 0, valid.error?.message ?? valid.stderr);
    writeFileSync(join(work, 'crlf.patch'), patch.replaceAll('\n', '\r\n'));
    const invalid = git(source, ['apply', '--check', join(work, 'crlf.patch')]);
    assert.equal(invalid.error, undefined);
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /patch does not apply/);
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
});
