import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const { unzipSync, zipSync, strFromU8, strToU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');

const xml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const families = ['SimSun', 'Microsoft YaHei', 'Songti SC', 'Arial', 'Times New Roman'];
const scripts = ['中文预览', 'Καλημέρα', 'Привет', 'مرحبا', 'שלום', 'हिन्दी', '한국어', '日本語'];

function fuzzText(seed) {
  return `${scripts[seed % scripts.length]} seed-${seed} <&> ${'Ab中9'.repeat(8 + seed % 17)}`;
}

export function documentFixture(text = 'LibreOffice Node document test', family = 'Arial') {
  const xml = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  return zipSync({
    '[Content_Types].xml': strToU8(xml),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}"/></w:rPr><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`),
  });
}

/** Deterministic valid OOXML inputs used by engine-backed fuzz regression tests. */
export function officeFuzzFixture(extension, seed) {
  const family = families[seed % families.length];
  const text = fuzzText(seed);
  if (extension === 'docx') return documentFixture(xml(text), xml(family));
  const fixture = extension === 'pptx' ? 'one-slide.pptx' : extension === 'xlsx' ? 'one-sheet.xlsx' : undefined;
  if (fixture === undefined) throw new Error(`Unsupported fuzz fixture extension: ${extension}`);
  const files = unzipSync(readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url)));
  if (extension === 'pptx') {
    const name = 'ppt/slides/slide1.xml';
    const slide = strFromU8(files[name]).replace(/typeface="[^"]*"/g, `typeface="${xml(family)}"`)
      .replace(/<a:t>.*?<\/a:t>/g, `<a:t>${xml(text)}</a:t>`);
    files[name] = strToU8(slide);
  } else {
    const name = 'xl/worksheets/sheet1.xml';
    files[name] = strToU8(strFromU8(files[name]).replace(/<t>.*?<\/t>/g, `<t>${xml(text)}</t>`));
  }
  return zipSync(files, { level: seed % 3 });
}
