/** Synthetic EMF multi-format comment containing a vector PDF; no external resources. */
export function embeddedPdfDocumentParts() {
  const content = 'q 0 0 1 rg 0 0 72 72 re f 1 0 0 rg 12 12 48 48 re f Q\n';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}endstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdfBytes = Buffer.from(pdf);
  const comment = Buffer.alloc(Math.ceil((56 + pdfBytes.length) / 4) * 4);
  const values = [70, comment.length, comment.length - 12, 0x43494447, 0x40000004,
    0, 0, 100, 100, 1, 0x50444620, 0, pdfBytes.length, 56];
  values.forEach((value, index) => comment.writeUInt32LE(value, index * 4));
  pdfBytes.copy(comment, 56);
  const header = Buffer.alloc(108);
  [[0, 1], [4, 108], [16, 100], [20, 100], [32, 2540], [36, 2540], [40, 0x464d4520], [44, 0x10000],
    [48, header.length + comment.length + 20], [52, 3], [72, 100], [76, 100], [80, 25], [84, 25], [100, 25000], [104, 25000]]
    .forEach(([offset, value]) => header.writeUInt32LE(value, offset));
  header.writeUInt16LE(1, 56);
  const eof = Buffer.alloc(20);
  eof.writeUInt32LE(14); eof.writeUInt32LE(20, 4); eof.writeUInt32LE(20, 16);
  return {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="emf" ContentType="image/x-emf"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="picture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/vector.emf"/></Relationships>',
    'word/media/vector.emf': Buffer.concat([header, comment, eof]),
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>
<w:p><w:r><w:t>Embedded PDF graphic</w:t></w:r></w:p>
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Embedded vector"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Embedded vector"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="picture"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`,
  };
}
