/** Bounded OOXML inspection and declared font diagnostics, using maintained ZIP/XML parsers. */
import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
import { normalize } from './fonts.js';
import { ConversionError } from './errors.js';

const MAIN_PARTS = {
  docx: ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  xlsx: ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  pptx: ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
};

/** Validate ZIP size and membership before decoding selected document XML. */
export function inspectDocument(bytes, extension, limits) {
  const main = MAIN_PARTS[extension];
  if (!main) throw new ConversionError('unsupported-format', 'Input extension must be docx, xlsx, or pptx.');
  const names = new Set();
  let total = 0;
  let files;
  try {
    files = unzipSync(bytes, { filter(entry) {
      total += entry.originalSize;
      if (names.has(entry.name) || names.size >= limits.maxArchiveEntries || !Number.isSafeInteger(total) || total > limits.maxUncompressedBytes) throw new Error('OOXML archive exceeds its limits or repeats an entry.');
      names.add(entry.name);
      return entry.name === '[Content_Types].xml' || (/^(word|xl|ppt)\/.*\.xml$/.test(entry.name) && !entry.name.endsWith('/fontTable.xml') && !entry.name.includes('/theme/'));
    } });
  } catch (cause) { throw new ConversionError('invalid-document', 'Input is not a supported, bounded OOXML archive.', { cause }); }
  if (!names.has('_rels/.rels') || !names.has(main[0]) || !files['[Content_Types].xml'] || !strFromU8(files['[Content_Types].xml']).includes(main[1])) throw new ConversionError('invalid-document', `Input does not contain a ${extension} document.`);
  const families = new Map();
  const codePoints = new Set();
  for (const [name, data] of Object.entries(files)) {
    if (name === '[Content_Types].xml') continue;
    const partFamilies = [];
    const partPoints = new Set();
    const parser = new SaxesParser({ xmlns: true });
    parser.on('opentag', tag => {
      const word = /wordprocessingml\/(?:2006\/)?main$/.test(tag.uri) && tag.local === 'rFonts';
      const drawing = /drawingml\/(?:2006\/)?main$/.test(tag.uri);
      const sheet = /spreadsheetml\/(?:2006\/)?main$/.test(tag.uri) && tag.local === 'name';
      for (const attribute of Object.values(tag.attributes)) {
        if ((word && ['ascii', 'hAnsi', 'eastAsia', 'cs'].includes(attribute.local)) || (drawing && attribute.local === 'typeface') || (sheet && attribute.local === 'val')) partFamilies.push(attribute.value);
      }
    });
    parser.on('text', text => { for (const char of text) if (!/\s/u.test(char)) partPoints.add(char.codePointAt(0)); });
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8';
    try { parser.write(new TextDecoder(encoding).decode(data)).close(); } catch {
      // LibreOffice can repair some invalid XML; damaged parts do not supply font diagnostics.
      continue;
    }
    for (const names of partFamilies) for (const family of names.split(';').map(value => value.trim()).filter(value => value && !/^\+(?:mj|mn)-(?:lt|ea|cs)$/.test(value))) families.set(normalize(family), family);
    for (const point of partPoints) codePoints.add(point);
  }
  return { families, codePoints: [...codePoints] };
}
