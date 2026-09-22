/** Deterministic generated OOXML and mutation coverage for bounded document inspection. */
import { readFileSync } from 'node:fs'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { inspectDocument } from '../src/document.ts'
import { ConversionError } from '../src/errors.ts'
import { normalize } from '../src/fonts.ts'
import { resolveOptions } from '../src/options.ts'
import { documentFixture } from './document-fixture.ts'

const options = resolveOptions()
const base = {
  pptx: readFileSync(new URL('../../../test/fixtures/one-slide.pptx', import.meta.url)),
  xlsx: readFileSync(new URL('../../../test/fixtures/one-sheet.xlsx', import.meta.url)),
}
const families = ['SimSun', 'Microsoft YaHei', 'Songti SC', 'Arial', 'Times New Roman', 'Fixture & Serif']
const scripts = ['中文预览', 'Καλημέρα', 'Привет', 'مرحبا', 'שלום', 'हिन्दी', '한국어', '日本語']

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function text(seed: number): string {
  return `${scripts[seed % scripts.length]} seed-${seed} <&> ${'Ab中9'.repeat(8 + seed % 17)}`
}

function fixture(extension: 'docx' | 'pptx' | 'xlsx', seed: number): { bytes: Uint8Array; family: string; text: string } {
  const family = families[seed % families.length]!
  const value = text(seed)
  if (extension === 'docx') return { bytes: documentFixture(escapeXml(value), escapeXml(family)), family, text: value }
  const files = unzipSync(base[extension])
  if (extension === 'pptx') {
    const name = 'ppt/slides/slide1.xml'
    files[name] = strToU8(strFromU8(files[name]!).replace(/typeface="[^"]*"/g, `typeface="${escapeXml(family)}"`)
      .replace(/<a:t>.*?<\/a:t>/g, `<a:t>${escapeXml(value)}</a:t>`))
  } else {
    const sheet = 'xl/worksheets/sheet1.xml'
    files[sheet] = strToU8(strFromU8(files[sheet]!).replace(/<t>.*?<\/t>/g, `<t>${escapeXml(value)}</t>`))
    files['xl/styles.xml'] = strToU8(`<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><name val="${escapeXml(family)}"/></font></fonts></styleSheet>`)
  }
  return { bytes: zipSync(files, { level: seed % 3 as 0 | 1 | 2 }), family, text: value }
}

function random(seed: number): () => number {
  let state = seed >>> 0
  return () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x100000000)
}

describe('deterministic OOXML fuzz corpus', () => {
  it('extracts fonts and Unicode scalars from generated DOCX, PPTX, and XLSX documents', () => {
    for (const extension of ['docx', 'pptx', 'xlsx'] as const) {
      for (let seed = 0; seed < 24; seed++) {
        const generated = fixture(extension, seed)
        const metadata = inspectDocument(generated.bytes, extension, options)
        expect(metadata.families.get(normalize(generated.family))).toBe(generated.family)
        for (const character of generated.text) {
          if (!/\s/u.test(character)) expect(metadata.codePoints).toContain(character.codePointAt(0))
        }
      }
    }
  })

  it('classifies deterministic byte mutations without returning unbounded metadata', () => {
    for (const extension of ['docx', 'pptx', 'xlsx'] as const) {
      const source = fixture(extension, 7).bytes
      const next = random(0x4832 + extension.length)
      for (let seed = 0; seed < 64; seed++) {
        const length = seed % 4 === 0 ? Math.max(1, Math.floor(source.length * next())) : source.length
        const mutated = source.slice(0, length)
        const changes = 1 + seed % 4
        for (let index = 0; index < changes; index++) {
          const offset = Math.min(mutated.length - 1, Math.floor(next() * mutated.length))
          mutated[offset] ^= 1 + Math.floor(next() * 255)
        }
        try {
          const metadata = inspectDocument(mutated, extension, options)
          expect(metadata.families.size).toBeLessThanOrEqual(128)
          expect(metadata.codePoints.length).toBeLessThanOrEqual(4096)
        } catch (error) {
          expect(error).toBeInstanceOf(ConversionError)
          expect((error as ConversionError).code).toBe('invalid-document')
        }
      }
    }
  })

  it('applies archive entry and expanded-byte limits to every generated format', () => {
    for (const extension of ['docx', 'pptx', 'xlsx'] as const) {
      const generated = fixture(extension, 11).bytes
      expect(() => inspectDocument(generated, extension, { ...options, maxArchiveEntries: 1 })).toThrow(/bounded OOXML/)
      expect(() => inspectDocument(generated, extension, { ...options, maxUncompressedBytes: 1 })).toThrow(/bounded OOXML/)
    }
  })
})
