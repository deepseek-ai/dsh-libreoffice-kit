/** Bounded OOXML inspection and declared font diagnostics, using maintained ZIP/XML parsers. */
import { unzipSync, strFromU8 } from 'fflate'
import { SaxesParser } from 'saxes'
import { normalize } from './fonts.ts'
import { ConversionError } from './errors.ts'
import type { ResolvedOptions } from './options.ts'

const MAIN_PARTS: Readonly<Record<string, readonly [string, string]>> = {
  docx: ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  xlsx: ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  pptx: ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
}

/** Declared font families and scalar values one inspected document carries. */
export interface DocumentFontMetadata {
  /** Normalized family key to the family name as the document declared it. */
  readonly families: Map<string, string>
  readonly codePoints: readonly number[]
}

/**
 * @param character - One code point as yielded by iteration over a string.
 * @returns the Unicode scalar the character encodes; iteration never yields an empty string.
 */
function codePointOf(character: string): number {
  return character.codePointAt(0) as number
}

/**
 * Validate ZIP size and membership before decoding selected document XML.
 * @param bytes - Complete source document bytes.
 * @param extension - Input extension, which selects the main document part.
 * @param limits - Archive entry and declared uncompressed byte limits.
 * @returns declared font families and the scalar values readable document XML declares.
 * @throws ConversionError when the extension is unsupported or the archive violates its limits.
 */
export function inspectDocument(bytes: Uint8Array, extension: string,
  limits: Pick<ResolvedOptions, 'maxArchiveEntries' | 'maxUncompressedBytes'>): DocumentFontMetadata {
  const main = MAIN_PARTS[extension]
  if (!main) throw new ConversionError('unsupported-format', 'Input extension must be docx, xlsx, or pptx.')
  const names = new Set<string>()
  let total = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter(entry) {
      total += entry.originalSize
      if (names.has(entry.name) || names.size >= limits.maxArchiveEntries || !Number.isSafeInteger(total) || total > limits.maxUncompressedBytes) throw new Error('OOXML archive exceeds its limits or repeats an entry.')
      names.add(entry.name)
      return entry.name === '[Content_Types].xml' || (/^(word|xl|ppt)\/.*\.xml$/.test(entry.name) && !entry.name.endsWith('/fontTable.xml') && !entry.name.includes('/theme/'))
    } })
  } catch (cause) { throw new ConversionError('invalid-document', 'Input is not a supported, bounded OOXML archive.', { cause }) }
  const contentTypes = files['[Content_Types].xml']
  if (!names.has('_rels/.rels') || !names.has(main[0]) || contentTypes === undefined || !strFromU8(contentTypes).includes(main[1])) throw new ConversionError('invalid-document', `Input does not contain a ${extension} document.`)
  const families = new Map<string, string>()
  const codePoints = new Set<number>()
  for (const [name, data] of Object.entries(files)) {
    if (name === '[Content_Types].xml') continue
    const partFamilies: string[] = []
    const partPoints = new Set<number>()
    const parser = new SaxesParser({ xmlns: true })
    parser.on('opentag', (tag) => {
      const word = /wordprocessingml\/(?:2006\/)?main$/.test(tag.uri) && tag.local === 'rFonts'
      const drawing = /drawingml\/(?:2006\/)?main$/.test(tag.uri)
      const sheet = /spreadsheetml\/(?:2006\/)?main$/.test(tag.uri) && tag.local === 'name'
      for (const attribute of Object.values(tag.attributes)) {
        if ((word && ['ascii', 'hAnsi', 'eastAsia', 'cs'].includes(attribute.local)) || (drawing && attribute.local === 'typeface') || (sheet && attribute.local === 'val')) partFamilies.push(attribute.value)
      }
    })
    parser.on('text', (text) => { for (const char of text) if (!/\s/u.test(char)) partPoints.add(codePointOf(char)) })
    const encoding = data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : data[0] === 0xfe && data[1] === 0xff ? 'utf-16be' : 'utf-8'
    try { parser.write(new TextDecoder(encoding).decode(data)).close() } catch {
      // LibreOffice can repair some invalid XML; damaged parts do not supply font diagnostics.
      continue
    }
    for (const declared of partFamilies) for (const family of declared.split(';').map(value => value.trim()).filter(value => value && !/^\+(?:mj|mn)-(?:lt|ea|cs)$/.test(value))) families.set(normalize(family), family)
    for (const point of partPoints) codePoints.add(point)
  }
  return { families, codePoints: [...codePoints] }
}
