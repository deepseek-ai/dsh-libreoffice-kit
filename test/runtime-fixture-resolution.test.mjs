import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { root } from '../scripts/platform-matrix.mjs';

test('installed operation fixtures load without dependencies in the source checkout', t => {
  const work = mkdtempSync(join(tmpdir(), 'kit-fixture-resolution-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const source = join(work, 'source/test');
  const consumer = join(work, 'consumer');
  const entry = join(consumer, 'node_modules/@deepseek-ai/libreoffice-kit/lib/index.js');
  mkdirSync(source, { recursive: true });
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(entry, 'export {};\n');
  const require = createRequire(join(root, 'packages/entry/package.json'));
  cpSync(dirname(dirname(require.resolve('fflate'))), join(consumer, 'node_modules/fflate'), { recursive: true });
  for (const file of ['runtime-fixture.mjs', 'runtime-operations.test.mjs'])
    cpSync(join(root, 'test', file), join(source, file));
  const env = { ...process.env, LIBREOFFICE_RUNTIME_ENTRY: entry, NODE_PATH: '', NODE_OPTIONS: '' };
  const check = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import { documentFixture } from ${JSON.stringify(pathToFileURL(join(source, 'runtime-fixture.mjs')).href)};
    const { unzipSync } = createRequire(process.env.LIBREOFFICE_RUNTIME_ENTRY)('fflate');
    const text = new TextDecoder().decode(unzipSync(documentFixture('isolated fixture'))['word/document.xml']);
    if (!text.includes('isolated fixture')) throw new Error('Fixture did not round trip');
  `], { cwd: consumer, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(check.status, 0, check.stderr);
  // Loading the actual suite catches dependencies resolved before its test bodies run.
  const suite = spawnSync(process.execPath, ['--test', '--test-name-pattern=^$', join(source, 'runtime-operations.test.mjs')],
    { cwd: consumer, env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(suite.status, 0, `${suite.stderr}\n${suite.stdout}`);
});
