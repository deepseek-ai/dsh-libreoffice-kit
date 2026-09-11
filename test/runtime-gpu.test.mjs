import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const entry = process.env.LIBREOFFICE_RUNTIME_ENTRY;
const input = process.env.LIBREOFFICE_GPU_DOCUMENT;
for (const gpu of ['webgpu', 'webgl2', 'webgl1']) test(`real Node WASM ${gpu} conversion preserves Chinese/English text`, { skip: !entry || !input, timeout: 180_000 }, async () => {
  const saved = process.env.LIBREOFFICE_VALIDATION_DIR;
  if (saved) await mkdir(resolve(saved), { recursive: true });
  const root = await mkdtemp(join(saved ? resolve(saved) : tmpdir(), `${gpu}-`));
  const { createConverter } = await import(pathToFileURL(entry).href);
  const converter = await createConverter({ gpu, timeoutMs: 120_000, maxImageResolution: 192 });
  try {
    const outputPath = join(root, 'report.pdf');
    const result = await converter.render({ inputPath: resolve(input), outputPath });
    await converter.dispose();
    const [{ stdout: text }, { stdout: fonts }, { stdout: info }] = await Promise.all([
      exec('pdftotext', ['-layout', outputPath, '-']), exec('pdffonts', [outputPath]), exec('pdfinfo', [outputPath]),
    ]);
    const evidence = { ...result, inputSha256: createHash('sha256').update(await readFile(input)).digest('hex'),
      pdfBytes: (await readFile(outputPath)).length, englishTextPresent: text.includes('Office preview benchmark 1'),
      chineseTextPresent: text.replaceAll(/\s/g, '').includes('中文排版测试：文档预览、表格与图片。'), fontReport: fonts, pdfInfo: info };
    await Promise.all([writeFile(join(root, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`), writeFile(join(root, 'text.txt'), text), writeFile(join(root, 'fonts.txt'), fonts), writeFile(join(root, 'pdfinfo.txt'), info)]);
    assert.equal(result.backend, 'wasm');
    assert.equal(result.imageScaling.backend, gpu);
    assert.ok(result.imageScaling.attempted > 0);
    assert.ok(result.imageScaling.accelerated > 0);
    assert.equal(result.imageScaling.failed, 0);
    assert.ok(evidence.englishTextPresent);
    assert.ok(evidence.chineseTextPresent);
    assert.match(fonts, /yes\s+yes\s+yes/);
    assert.match(info, /Pages:\s+3/);
    console.log(JSON.stringify({ validationDirectory: root, ...evidence }));
  } finally { await converter.dispose(); if (!saved) await rm(root, { recursive: true, force: true }); }
});
