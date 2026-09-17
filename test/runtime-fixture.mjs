import { createRequire } from 'node:module';
const { zipSync, unzipSync, strToU8, strFromU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');

export function documentFixture(text = 'LibreOffice Node document test', family = 'Arial') {
  const xml = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  return zipSync({
    '[Content_Types].xml': strToU8(xml),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml': strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:rFonts w:ascii="${family}" w:hAnsi="${family}"/></w:rPr><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`),
  });
}

export function commentedDocumentFixture() {
  const parts = unzipSync(documentFixture('A document with a comment'));
  parts['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>'));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml'])
    .replace('<w:p>', '<w:p><w:commentRangeStart w:id="0"/>')
    .replace('</w:p>', '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>'));
  parts['word/_rels/document.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdComments" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/></Relationships>');
  parts['word/comments.xml'] = strToU8('<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="Test" w:initials="T" w:date="2000-01-01T00:00:00Z"><w:p><w:r><w:t>A standard Word comment.</w:t></w:r></w:p></w:comment></w:comments>');
  return zipSync(parts);
}
