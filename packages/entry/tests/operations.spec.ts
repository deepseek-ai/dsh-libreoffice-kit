/** Public conversion validation rejects requests before queue admission or file IO. */
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { CONVERSION_FORMATS, resolveConversion, validateOutput } from '../src/operations.ts'
import type { ConversionRequest } from '../src/operations.ts'

const path = (name: string) => join(tmpdir(), name)
const request = (input: string, output: string): ConversionRequest => ({ inputPath: path(`input.${input}`), outputPath: path(`output.${output}`) })

describe('document operations', () => {
  for (const group of CONVERSION_FORMATS) for (const input of group.inputs) for (const output of group.outputs) {
    it(`converts ${input} to ${output}`, () => {
      expect(resolveConversion(request(input, output), 'convert')).toMatchObject({ extension: input, format: output, recalculate: false })
    })
  }
  it('keeps the PDF API independent of the output suffix', () => {
    expect(resolveConversion(request('DOCX', 'bin'), 'render')).toMatchObject({ extension: 'docx', format: 'pdf' })
  })
  it('accepts recalculation only for supported spreadsheets and editable output formats', () => {
    for (const input of ['xls', 'xlsx', 'ods']) for (const output of ['xlsx', 'ods'])
      expect(resolveConversion(request(input, output), 'recalculate')).toMatchObject({ recalculate: true, format: output })
    for (const [input, output] of [['docx', 'docx'], ['xlsx', 'pdf'], ['xlsx', 'csv']])
      expect(() => resolveConversion(request(input!, output!), 'recalculate')).toThrow(/Recalculation requires/)
  })
  it('rejects unsupported format families, missing suffixes, invalid paths, and identical paths', () => {
    for (const pair of [['docx', 'xlsx'], ['png', 'pdf'], ['docx', ''], ['', 'pdf']])
      expect(() => resolveConversion(request(pair[0]!, pair[1]!), 'convert')).toThrow(/Unsupported conversion/)
    const valid = request('docx', 'pdf')
    for (const invalid of [null, undefined, {}, { ...valid, inputPath: 'relative.docx' }, { ...valid, outputPath: 'relative.pdf' },
      { ...valid, inputPath: `${valid.inputPath}\0` }, { ...valid, outputPath: `${valid.outputPath}\0` }])
      expect(() => resolveConversion(invalid as ConversionRequest, 'convert')).toThrow(/absolute filesystem paths/)
    expect(() => resolveConversion({ ...valid, outputPath: valid.inputPath }, 'convert')).toThrow(/must differ/)
  })
  it('preserves exact CSV worksheet names and rejects misplaced or empty selections', () => {
    expect(resolveConversion({ ...request('xlsx', 'csv'), sheet: 'Sheet 2 中文' }, 'convert').sheet).toBe('Sheet 2 中文')
    for (const sheet of ['', ' ', 'a\0', 2])
      expect(() => resolveConversion({ ...request('xlsx', 'csv'), sheet } as ConversionRequest, 'convert')).toThrow(/sheet must/)
    expect(() => resolveConversion({ ...request('xlsx', 'pdf'), sheet: 'Sheet1' }, 'convert')).toThrow(/only for CSV/)
  })
  it('checks binary signatures while accepting empty text exports', () => {
    validateOutput(new TextEncoder().encode('%PDF-1.7'), 'pdf')
    validateOutput(new Uint8Array([0x50, 0x4b, 3, 4]), 'xlsx')
    for (const format of ['csv', 'txt']) validateOutput(new Uint8Array(), format)
    for (const format of ['pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'])
      expect(() => validateOutput(new TextEncoder().encode('wrong bytes'), format)).toThrow(/did not produce/)
  })
})
