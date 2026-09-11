/** Real Node eval/stdin consumers must not pass their input mode to file-based conversion workers. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { documentFixture } from './runtime-fixture.mjs';

const entry = process.env.LIBREOFFICE_RUNTIME_ENTRY;
test('real converter supports Node ESM eval and stdin callers', { skip: !entry, timeout: 240_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-input-type-test-'));
  try {
    const inputPath = join(root, 'document.docx');
    await writeFile(inputPath, documentFixture('Node ESM input modes 中文'));
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP']
      .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    for (const mode of ['eval', 'stdin']) {
      const outputPath = join(root, `${mode}.pdf`);
      const source = `import {createConverter} from ${JSON.stringify(pathToFileURL(entry).href)};
const converter=await createConverter({gpu:'off',timeoutMs:90000});
try { const result=await converter.render(${JSON.stringify({ inputPath, outputPath })});
  process.stdout.write(JSON.stringify({backend:result.backend,mode:${JSON.stringify(mode)}}));
} finally { await converter.dispose(); }`;
      const stdout = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, ['--input-type=module', ...(mode === 'eval' ? ['--eval', source] : [])],
          { env, timeout: 100_000, killSignal: 'SIGKILL', maxBuffer: 65_536 },
          (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin.end(mode === 'stdin' ? source : undefined);
      });
      const result = JSON.parse(stdout);
      assert.equal(result.mode, mode);
      if (process.env.LIBREOFFICE_RUNTIME_EXPECT_BACKEND) assert.equal(result.backend, process.env.LIBREOFFICE_RUNTIME_EXPECT_BACKEND);
      const pdf = await readFile(outputPath);
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      assert.ok(pdf.length > 100);
      t.diagnostic(JSON.stringify({ ...result, pdfBytes: pdf.length }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
