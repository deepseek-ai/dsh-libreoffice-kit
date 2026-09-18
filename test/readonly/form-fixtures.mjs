/** Synthetic form fields exercise model changes that pixel and undo checks can miss. */
import { createRequire } from 'node:module';
const { zipSync, strToU8 } = createRequire(new URL('../../packages/entry/package.json', import.meta.url))('fflate');
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const contentTypes = (main, type) => `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="${type}"/></Types>`;
const pack = files => zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
/** Letter-size Writer document carrying one legacy checkbox form field. */
export function formCheckboxFixture() {
  const w = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  return pack({
    '[Content_Types].xml': contentTypes('word/document.xml',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
    '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${w}"><w:body>`
      + '<w:p><w:r><w:t>Read-only form preview. The checkbox below must stay read-only.</w:t></w:r></w:p>'
      + '<w:p><w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:name w:val="AuditCheck"/>'
      + '<w:enabled/><w:calcOnExit w:val="0"/><w:checkBox><w:sizeAuto/><w:default w:val="0"/></w:checkBox>'
      + '</w:ffData></w:fldChar></w:r>'
      + '<w:r><w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r>'
      + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
      + '<w:r><w:t>AuditCheck</w:t></w:r>'
      + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
      + '<w:p><w:r><w:t>Trailing paragraph after the checkbox.</w:t></w:r></w:p>'
      + '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/>'
      + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>'
      + '</w:sectPr></w:body></w:document>',
  });
}


/** A checked Word content control on the first line with fixed page margins. */
export function contentControlFixture() {
  return pack({
    '[Content_Types].xml': contentTypes('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'),
    '_rels/.rels': `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body><w:p><w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="1"/><w14:checkedState w14:val="2612"/><w14:uncheckedState w14:val="2610"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>☒</w:t></w:r></w:sdtContent></w:sdt></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:left="1134" w:right="1134" w:top="1134" w:bottom="1134"/></w:sectPr></w:body></w:document>',
  });
}
