/** Executed after copying into the isolated installed consumer. */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import { zipSync, strToU8 } from 'fflate';
import { createConverter } from '@deepseek-ai/libreoffice-kit';
import { linkedDocumentParts } from './runtime-linked-fixture.mjs';

const parts = {
  '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>LibreOffice Kit installed conversion 你好</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>',
};
const inputPath = resolve('roundtrip.docx');
const outputPath = resolve('roundtrip.pdf');
await writeFile(inputPath, zipSync(Object.fromEntries(Object.entries(parts).map(([name, value]) => [name, strToU8(value)]))));
const converter = await createConverter({ gpu: 'off' });
let requests = 0;
const server = createServer((_request, response) => {
  requests++;
  response.writeHead(200, { 'Content-Type': 'image/png' });
  response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
});
try {
  assert.equal(converter.backend, process.argv[2]);
  const result = await converter.render({ inputPath, outputPath });
  const pdf = await readFile(outputPath);
  assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
  assert.match(pdf.subarray(-2048).toString('latin1'), /%%EOF/);
  const formats = { docx: { backend: result.backend, pdfBytes: pdf.length, missingFonts: result.missingFonts } };
  for (const [extension, fixture] of [['xlsx', 'one-sheet.xlsx'], ['pptx', 'one-slide.pptx']]) {
    const formatOutput = resolve(`roundtrip.${extension}.pdf`);
    const converted = await converter.render({ inputPath: resolve('fixtures', fixture), outputPath: formatOutput });
    const bytes = await readFile(formatOutput);
    assert.equal(converted.backend, converter.backend);
    assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-', `${extension} output is not PDF`);
    assert.match(bytes.subarray(-2048).toString('latin1'), /%%EOF/, `${extension} PDF is incomplete`);
    assert.ok(bytes.length > 100, `${extension} PDF is empty`);
    formats[extension] = { backend: converted.backend, pdfBytes: bytes.length, missingFonts: converted.missingFonts };
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}/linked-image.png`;
  await (await fetch(url)).arrayBuffer();
  assert.equal(requests, 1, 'External resource sentinel did not observe its positive control');
  requests = 0;
  const externalParts = linkedDocumentParts(`http://127.0.0.1:${server.address().port}`);
  const externalInput = resolve('external.docx');
  const externalOutput = resolve('external.pdf');
  await writeFile(externalInput, zipSync(Object.fromEntries(Object.entries(externalParts).map(([name, value]) => [name, strToU8(value)]))));
  await converter.render({ inputPath: externalInput, outputPath: externalOutput });
  assert.equal((await readFile(externalOutput)).subarray(0, 5).toString('ascii'), '%PDF-');
  assert.equal(requests, 0, 'Document conversion fetched an external HTTP image');
  await writeFile(resolve('smoke-result.json'), `${JSON.stringify({ backend: result.backend, pdfBytes: pdf.length, missingFonts: result.missingFonts, externalRequests: requests, formats })}\n`);
} finally {
  await converter.dispose();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
