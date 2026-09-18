/** Select bounded OOXML inspection or a legacy Office compound-file import. */
import { ConversionError } from './errors.ts'
import { inspectDocument as inspectOoxml } from './ooxml.ts'
import type { DocumentFontMetadata } from './ooxml.ts'
import type { ResolvedOptions } from './options.ts'

/** Input suffixes accepted by the public converter. */
export const DOCUMENT_EXTENSIONS = ['doc', 'docx', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp'] as const

const COMPOUND_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

/**
 * Inspect the input container before invoking LibreOffice's document importer.
 * Compound-file streams and legacy font tables are interpreted by LibreOffice;
 * they do not supply the API's OOXML font diagnostics.
 * @param bytes - Source bytes already bounded by maxInputBytes.
 * @param extension - Lowercase source suffix.
 * @param limits - Limits applied to ZIP-based document contents.
 * @returns OOXML font metadata, or empty diagnostics for a binary document.
 */
export function inspectDocument(bytes: Uint8Array, extension: string,
  limits: Pick<ResolvedOptions, 'maxArchiveEntries' | 'maxUncompressedBytes'>): DocumentFontMetadata {
  if (!(DOCUMENT_EXTENSIONS as readonly string[]).includes(extension))
    throw new ConversionError('unsupported-format', `Input extension must be ${DOCUMENT_EXTENSIONS.join(', ')}.`)
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(extension)) return inspectOoxml(bytes, extension, limits)
  if (bytes.length < 512 || !COMPOUND_SIGNATURE.every((value, index) => bytes[index] === value))
    throw new ConversionError('invalid-document', 'Legacy Office input must contain an OLE compound document.')
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = header.getUint16(26, true)
  const sectorShift = header.getUint16(30, true)
  if (header.getUint16(28, true) !== 0xfffe || header.getUint16(32, true) !== 6
    || !((version === 3 && sectorShift === 9) || (version === 4 && sectorShift === 12))
    || bytes.length < 2 ** sectorShift * 2 || bytes.length % 2 ** sectorShift !== 0)
    throw new ConversionError('invalid-document', 'Legacy Office input has an invalid or truncated compound-file header.')
  return { families: new Map(), codePoints: [] }
}
