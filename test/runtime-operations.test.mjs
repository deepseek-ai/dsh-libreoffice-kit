/** Real engine export matrix, calculation completion, and the public offline CLI. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { documentFixture } from './runtime-fixture.mjs';

const entry = process.env.LIBREOFFICE_RUNTIME_ENTRY;
const exec = promisify(execFile);
const { unzipSync } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');
const fixture = name => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const xml = (parts, name) => new TextDecoder().decode(parts[name]);

function assertCalculated(bytes) {
  const parts = unzipSync(bytes);
  const sheet = xml(parts, 'xl/worksheets/sheet2.xml');
  for (const [cell, value] of [['A1', 16], ['A2', 48]]) {
    const body = sheet.match(new RegExp(`<c\\b[^>]*r="${cell}"[^>]*>(.*?)</c>`, 's'))?.[1];
    assert.ok(body, `Missing ${cell}`);
    assert.match(body, /<f\b[^>]*>.+<\/f>/, `Formula lost in ${cell}`);
    assert.equal(Number(body.match(/<v>(.*?)<\/v>/)?.[1]), value, `Stale calculation in ${cell}`);
  }
}

test('public converter exports every declared format pair using the installed engine', { skip: !entry, timeout: 1_800_000 }, async t => {
  const { createConverter, CONVERSION_FORMATS } = await import(pathToFileURL(entry).href);
  const converter = await createConverter({ timeoutMs: 120_000 });
  const root = await mkdtemp(join(tmpdir(), 'kit-format-matrix-'));
  try {
    await writeFile(join(root, 'source.docx'), documentFixture('Conversion matrix 中文'));
    for (const [extension, name] of [['doc', 'one-page.doc'], ['xls', 'one-sheet.xls'], ['xlsx', 'one-sheet.xlsx'], ['ppt', 'one-slide.ppt'], ['pptx', 'one-slide.pptx']])
      await writeFile(join(root, `source.${extension}`), await fixture(name));
    for (const [input, output] of [['docx', 'odt'], ['xlsx', 'ods'], ['pptx', 'odp']])
      await converter.convert({ inputPath: join(root, `source.${input}`), outputPath: join(root, `source.${output}`) });
    for (const group of CONVERSION_FORMATS) for (const input of group.inputs) for (const output of group.outputs) {
      const outputPath = join(root, `${input}-to.${output}`);
      const result = await converter.convert({ inputPath: join(root, `source.${input}`), outputPath });
      const bytes = await readFile(outputPath);
      assert.ok(bytes.length > 0, `${input} → ${output} is empty`);
      if (output === 'pdf') assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      else if (!['txt', 'csv'].includes(output)) assert.ok(Object.keys(unzipSync(bytes)).length > 1);
      t.diagnostic(JSON.stringify({ input, output, backend: result.backend, bytes: bytes.length }));
    }
  } finally { await converter.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('recalculation saves refreshed cross-sheet caches and CSV exports only the named sheet', { skip: !entry, timeout: 600_000 }, async () => {
  const { createConverter, discoverRuntime } = await import(pathToFileURL(entry).href);
  const root = await mkdtemp(join(tmpdir(), 'kit-calculation-'));
  const converter = await createConverter();
  try {
    const inputPath = join(root, 'formulas.xlsx');
    await writeFile(inputPath, await fixture('cross-sheet-formulas.xlsx'));
    const outputPath = join(root, 'checked.xlsx');
    await converter.recalculate({ inputPath, outputPath });
    assertCalculated(await readFile(outputPath));
    const ods = join(root, 'checked.ods');
    await converter.recalculate({ inputPath, outputPath: ods });
    const roundtrip = join(root, 'roundtrip.xlsx');
    await converter.convert({ inputPath: ods, outputPath: roundtrip });
    assertCalculated(await readFile(roundtrip));
    const csv = join(root, 'selected.csv');
    await converter.convert({ inputPath: outputPath, outputPath: csv, sheet: 'Summary 中文' });
    assert.equal((await readFile(csv, 'utf8')).replaceAll('\r\n', '\n'), '16,selected sheet\n48,\n');
    for (const sheet of [undefined, 'No such worksheet']) {
      const failed = join(root, 'failed.csv');
      await assert.rejects(converter.convert({ inputPath, outputPath: failed, ...(sheet ? { sheet } : {}) }), /sheet/i);
      await assert.rejects(readFile(failed), { code: 'ENOENT' });
    }
    await assert.rejects(converter.recalculate({ inputPath, outputPath }), { code: 'EEXIST' });
    await assert.rejects(converter.recalculate({ inputPath, outputPath: inputPath }), /must differ/);
    const runtime = await discoverRuntime();
    const environment = { ...process.env, HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1' };
    const options = { env: environment, timeout: 180_000, maxBuffer: 65_536 };
    const { stdout } = await exec(process.execPath, [runtime.cliPath, 'capabilities', '--json'], options);
    const capabilities = JSON.parse(stdout);
    assert.deepEqual(capabilities.runtime, runtime);
    const cliOutput = join(root, 'cli.xlsx');
    await exec(process.execPath, [runtime.cliPath, 'recalculate', '--input', inputPath, '--output', cliOutput], options);
    assertCalculated(await readFile(cliOutput));
    const cliCsv = join(root, 'cli.csv');
    await exec(process.execPath, [runtime.cliPath, 'convert', '--input', cliOutput, '--output', cliCsv, '--sheet', 'Inputs'], options);
    assert.equal((await readFile(cliCsv, 'utf8')).replaceAll('\r\n', '\n'), '7\n9\n');
  } finally { await converter.dispose(); await rm(root, { recursive: true, force: true }); }
});
