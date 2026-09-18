import { zipSync, strToU8 } from 'fflate'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DOCUMENT_EXTENSIONS, inspectDocument } from '../src/document.ts'
import { resolveOptions } from '../src/options.ts'

const options = resolveOptions()
const fixture = (name: string) => readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url))

describe('Office input containers', () => {
  it.each([['doc', 'one-page.doc'], ['xls', 'one-sheet.xls'], ['ppt', 'one-slide.ppt']])('accepts a real %s compound file without inventing font diagnostics', (extension, name) => {
    expect(inspectDocument(fixture(name), extension, options)).toEqual({ families: new Map(), codePoints: [] })
  })

  it.each([['odt', 'text'], ['ods', 'spreadsheet'], ['odp', 'presentation']])('inspects bounded %s archives and declared fonts', (extension, type) => {
    const archive = (mime: string) => zipSync({
      mimetype: strToU8(mime), 'META-INF/manifest.xml': strToU8('<manifest/>'),
      'content.xml': strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"><office:text fo:font-family="Fixture Font">中文 test</office:text></office:document-content>'),
    })
    const bytes = archive(`application/vnd.oasis.opendocument.${type}`)
    expect(inspectDocument(bytes, extension, options).families.get('fixturefont')).toBe('Fixture Font')
    expect(inspectDocument(bytes, extension, options).codePoints).toContain('中'.codePointAt(0))
    expect(() => inspectDocument(bytes, extension, { ...options, maxUncompressedBytes: 1 })).toThrow(/bounded/)
    const missingMime = zipSync({ 'content.xml': strToU8('<doc/>'), 'META-INF/manifest.xml': strToU8('<manifest/>') })
    expect(() => inspectDocument(missingMime, extension, options)).toThrow(/does not contain/)
    expect(() => inspectDocument(archive('wrong'), extension, options)).toThrow(/does not contain/)
  })

  it('retains OOXML inspection and ZIP limits', () => {
    const bytes = fixture('one-sheet.xlsx')
    expect(inspectDocument(bytes, 'xlsx', options).codePoints).toContain('中'.codePointAt(0))
    expect(() => inspectDocument(bytes, 'xlsx', { ...options, maxArchiveEntries: 1 })).toThrow(/bounded OOXML/)
    expect(() => inspectDocument(bytes, 'xlsx', { ...options, maxUncompressedBytes: 1 })).toThrow(/bounded OOXML/)
    expect(() => inspectDocument(fixture('one-page.doc'), 'docx', options)).toThrow(/bounded OOXML/)
  })

  it.each(['wps', 'rtf', 'html', 'txt', ''])('does not enable %s input', extension => {
    expect(() => inspectDocument(fixture('one-page.doc'), extension, options)).toThrow(/Input extension must be/)
    expect(DOCUMENT_EXTENSIONS).not.toContain(extension)
  })

  it('rejects truncated, renamed ZIP and disguised text files', () => {
    for (const bytes of [new Uint8Array(7), fixture('one-page.doc').subarray(0, 511), fixture('one-sheet.xlsx'), new TextEncoder().encode('{\\rtf1 Not a binary Word document}')])
      expect(() => inspectDocument(bytes, 'doc', options)).toThrow(/OLE compound/)
    const modified = fixture('one-page.doc')
    modified[7] = 0
    expect(() => inspectDocument(modified, 'doc', options)).toThrow(/OLE compound/)
  })

  it('checks byte order, sector sizes, compound version and whole-file alignment', () => {
    for (const [offset, value] of [[26, 2], [28, 0], [30, 12], [32, 5]]) {
      const bytes = fixture('one-sheet.xls')
      bytes.writeUInt16LE(value, offset)
      expect(() => inspectDocument(bytes, 'xls', options)).toThrow(/compound-file header/)
    }
    expect(() => inspectDocument(fixture('one-sheet.xls').subarray(0, 512), 'xls', options)).toThrow(/truncated/)
    expect(() => inspectDocument(fixture('one-sheet.xls').subarray(0, -1), 'xls', options)).toThrow(/compound-file header/)
  })

  it('accepts version 4 headers and byte views with an offset; engine validation still owns streams', () => {
    const backing = new Uint8Array(8196)
    const bytes = backing.subarray(4)
    bytes.set(fixture('one-page.doc').subarray(0, 512))
    const header = new DataView(bytes.buffer, bytes.byteOffset)
    header.setUint16(26, 4, true)
    header.setUint16(30, 12, true)
    expect(inspectDocument(bytes, 'doc', options).families.size).toBe(0)
    header.setUint16(30, 9, true)
    expect(() => inspectDocument(bytes, 'doc', options)).toThrow(/compound-file header/)
  })
})
