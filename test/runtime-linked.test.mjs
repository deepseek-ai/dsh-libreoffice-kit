import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { linkedDocumentParts } from './runtime-linked-fixture.mjs';

const exec = promisify(execFile);
const { zipSync, strToU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');
const entry = process.env.LIBREOFFICE_RUNTIME_ENTRY;
test('real engine preserves cached linked content without requesting external HTTP resources', { skip: !entry, timeout: 180_000 }, async () => {
  const saved = process.env.LIBREOFFICE_VALIDATION_DIR;
  if (saved) await mkdir(resolve(saved), { recursive: true });
  const root = await mkdtemp(join(saved ? resolve(saved) : tmpdir(), 'linked-'));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    response.setHeader('Content-Type', 'text/plain');
    response.end('Remote replacement must never enter the PDF');
  });
  let converter;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
  };
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const probe = await fetch(`${baseUrl}/probe`);
    assert.equal(await probe.text(), 'Remote replacement must never enter the PDF');
    const inputPath = join(root, 'linked.docx');
    const outputPath = join(root, 'linked.pdf');
    const archive = zipSync(Object.fromEntries(Object.entries(linkedDocumentParts(baseUrl)).map(([name, text]) => [name, strToU8(text)])));
    await writeFile(inputPath, archive, { flag: 'wx', mode: 0o600 });
    const { createConverter } = await import(pathToFileURL(entry).href);
    converter = await createConverter({ gpu: 'off', timeoutMs: 120_000 });
    const result = await converter.render({ inputPath, outputPath });
    await converter.dispose();
    await close();
    const [{ stdout: text }, { stdout: fonts }] = await Promise.all([
      exec('pdftotext', ['-layout', outputPath, '-']), exec('pdffonts', [outputPath]),
    ]);
    const evidence = { backend: result.backend, requests, pdfBytes: (await readFile(outputPath)).length, cachedTextPresent: text.includes('Cached linked text stays available'), fontReport: fonts, loadOptions: 'Batch=true,EnableMacrosExecution=false' };
    await Promise.all([writeFile(join(root, 'result.json'), `${JSON.stringify(evidence, null, 2)}\n`), writeFile(join(root, 'text.txt'), text), writeFile(join(root, 'fonts.txt'), fonts)]);
    assert.deepEqual(requests, ['/probe']);
    assert.ok(text.includes('External links must remain unloaded'));
    assert.ok(evidence.cachedTextPresent);
    assert.ok(!text.includes('Remote replacement must never enter the PDF'));
    console.log(JSON.stringify({ validationDirectory: root, ...evidence }));
  } finally { await converter?.dispose(); await close(); if (!saved) await rm(root, { recursive: true, force: true }); }
});
