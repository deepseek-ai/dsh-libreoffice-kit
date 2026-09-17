/** Original OOXML fixtures with deterministic cells and object geometry for editing. */
import { createRequire } from 'node:module';
import { documentFixture } from './runtime-fixture.mjs';

const { zipSync, strToU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Generate one Writer paragraph, a two-sheet formula workbook, or a slide with a text box. */
export function editorFixture(format) {
  if (format === 'docx') return documentFixture('Office editor original', 'Liberation Sans');
  const files = {};
  const types = {};
  const main = format === 'xlsx' ? 'xl/workbook.xml' : 'ppt/presentation.xml';
  if (format === 'xlsx') {
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    types[main] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
    files[main] = `<workbook xmlns="${ns}" xmlns:r="${office}"><sheets><sheet name="First" sheetId="1" r:id="rId1"/><sheet name="Second" sheetId="2" r:id="rId2"/></sheets></workbook>`;
    files['xl/_rels/workbook.xml.rels'] = `<Relationships xmlns="${relationships}">${[1, 2].map(i => `<Relationship Id="rId${i}" Type="${office}/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('')}</Relationships>`;
    for (const index of [1, 2]) {
      const part = `xl/worksheets/sheet${index}.xml`;
      types[part] = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
      files[part] = `<worksheet xmlns="${ns}"><sheetData><row r="1"><c r="A1"><v>${index === 1 ? 2 : 7}</v></c><c r="B1"><f>A1*3</f><v>${index === 1 ? 6 : 21}</v></c></row></sheetData></worksheet>`;
    }
  } else if (format === 'pptx') {
    const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    types[main] = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
    types['ppt/slides/slide1.xml'] = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
    files[main] = `<p:presentation xmlns:p="${p}" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
    files['ppt/_rels/presentation.xml.rels'] = `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/></Relationships>`;
    files['ppt/slides/slide1.xml'] = `<p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Editor text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="1828800"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2400"><a:latin typeface="Liberation Sans"/></a:rPr><a:t>Office editor original</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  } else throw new Error(`Unsupported fixture: ${format}`);
  files['_rels/.rels'] = `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="${main}"/></Relationships>`;
  files['[Content_Types].xml'] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${Object.entries(types).map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('')}</Types>`;
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
}
