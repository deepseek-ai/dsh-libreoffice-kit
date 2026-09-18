/** Tiny synthetic PDFs: no embedded or redistributed system fonts. */
function pdf(pages, fonts) {
  const firstPage = 3 + fonts.length;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${firstPage + 2 * i} 0 R`).join(' ')}] >>`, ...fonts];
  for (const [i, page] of pages.entries()) {
    const resources = fonts.map((_, j) => `/F${j + 1} ${j + 3} 0 R`).join(' ');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${page.size.join(' ')}] ${page.crop ? `/CropBox [${page.crop.join(' ')}]` : ''} /Rotate ${page.rotation ?? 0} /Resources << /Font << ${resources} >> >> /Contents ${firstPage + 2 * i + 1} 0 R >>`,
      `<< /Length ${Buffer.byteLength(page.content)} >>\nstream\n${page.content}endstream`);
  }
  let text = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(text));
    text += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(text);
  text += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  return Buffer.from(`${text}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}
const type1 = name => `<< /Type /Font /Subtype /Type1 /BaseFont /${name} >>`;
const text = (font, size, x, y, value) => `BT /F${font} ${size} Tf ${x} ${y} Td (${value}) Tj ET\n`;
const ucs2 = value => Buffer.from(value, 'utf16le').swap16().toString('hex');

export function pdfRasterFixtures() {
  const geometry = [0, 90, 0, 270].map((rotation, i) => ({ size: [320, 220], rotation,
    ...(i < 2 ? {} : { crop: [40, 30, 280, 190] }),
    content: '0.93 0.96 1 rg 0 0 320 220 re f\n0 0 1 rg 10 170 40 40 re f\n1 0.5 0 rg 270 170 40 40 re f\n1 0 0 rg 10 10 40 40 re f\n0 0.7 0 rg 270 10 40 40 re f\n0 0 0 rg\n'
      + text(1, 18, 70, 110, 'ROTATE / CROP') + text(1, 12, 80, 90, `Page ${i + 1} - 320 x 220 pt`),
  }));
  // All characters in this PDF are present in the checked-in Roboto TTC face.
  const roboto = '<< /Type /Font /Subtype /TrueType /BaseFont /Roboto /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 122 '
    + `/Widths [${Array(91).fill(600).join(' ')}] /FontDescriptor << /Type /FontDescriptor /FontName /Roboto /Flags 32 /FontBBox [-500 -300 1400 1300] /ItalicAngle 0 /Ascent 927 /Descent -244 /CapHeight 710 /StemV 80 >> >>`;
  const cjk = '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 /FontDescriptor << /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >> >>] >>';
  return [
    { name: 'geometry', bytes: pdf(geometry, [type1('Helvetica')]), sizes: [[640, 440], [440, 640], [480, 320], [320, 480]], landmarks: true },
    { name: 'base14', bytes: pdf([{ size: [400, 240], content: text(1, 18, 20, 190, 'Helvetica: Quick brown fox 123') + text(2, 18, 20, 130, 'Times-Roman: Quick brown fox 123') + text(3, 18, 20, 70, 'Courier: Quick brown fox 123') }], [type1('Helvetica'), type1('Times-Roman'), type1('Courier')]), sizes: [[800, 480]] },
    { name: 'ttc', bytes: pdf([{ size: [400, 200], content: text(1, 32, 20, 140, 'AB ab c fi') + text(1, 18, 20, 90, 'AB fi') }], [roboto]), sizes: [[800, 400]] },
    { name: 'cjk', bytes: pdf([{ size: [440, 220], content: `BT /F1 22 Tf 20 150 Td <${ucs2('中文字体测试：保存与裁剪')}> Tj ET\nBT /F1 16 Tf 20 100 Td <${ucs2('这是没有嵌入字体的文档')}> Tj ET\n` }], [cjk]), sizes: [[880, 440]] },
  ];
}
