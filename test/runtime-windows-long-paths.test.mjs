import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { verifyWindowsLongPaths } from '../scripts/verify-windows-long-paths.mjs';

const entry = process.env.LIBREOFFICE_RUNTIME_ENTRY;
test('native Office resources load at 248/249 characters and in deeper directories', {
  skip: process.platform !== 'win32' || !entry, timeout: 240_000,
}, async () => {
  const require = createRequire(entry);
  const engine = dirname(require.resolve(`@deepseek-ai/libreoffice-kit-win32-${process.arch}/prebuilds.json`));
  const cases = await verifyWindowsLongPaths(engine);
  assert.equal(cases.length, 12);
  for (const format of ['docx', 'xlsx', 'pptx']) {
    assert.deepEqual(cases.filter(result => result.format === format).slice(1, 3).map(result => result.resourcePathLength), [248, 249]);
  }
});
