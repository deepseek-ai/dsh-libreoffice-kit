/** Synthetic Writer documents exercising automatic parity fillers and explicit blank pages. */
import { createRequire } from 'node:module';
import { documentFixture } from './runtime-fixture.mjs';
const { unzipSync, zipSync, strToU8 } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');

/**
 * @param {'oddPage' | 'evenPage' | 'blankPage'} kind - The Writer layout to exercise.
 * @returns {Uint8Array} Original DOCX bytes with fixed Latin text and no external resources.
 */
export function writerLayoutFixture(kind) {
  const entries = unzipSync(documentFixture());
  const paragraph = text => `<w:p><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`;
  const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
  const dimensions = '<w:pgSz w:w="12240" w:h="15840"/>';
  let body = paragraph('First synthetic content page');
  if (kind === 'blankPage') {
    body += pageBreak + pageBreak + paragraph('Final synthetic content page') + `<w:sectPr>${dimensions}</w:sectPr>`;
  } else {
    if (kind === 'evenPage') body += pageBreak + paragraph('Second synthetic content page');
    body += `<w:p><w:pPr><w:sectPr><w:type w:val="nextPage"/>${dimensions}</w:sectPr></w:pPr></w:p>`;
    body += paragraph('Final synthetic section') + `<w:sectPr><w:type w:val="${kind}"/>${dimensions}</w:sectPr>`;
  }
  entries['word/document.xml'] = strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
  return zipSync(entries);
}
