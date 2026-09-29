#!/usr/bin/env node
/** Offline CLI over the public converter; stdout contains one JSON result. */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { CONVERSION_FORMATS, IMAGE_FORMATS, createConverter, discoverRuntime } from './index.ts'
import type { ConverterOptions } from './index.ts'
import { failureCode } from './errors.ts'

const numericOptions = {
  'timeout-ms': 'timeoutMs', 'max-input-bytes': 'maxInputBytes', 'max-output-bytes': 'maxOutputBytes',
  'max-image-resolution': 'maxImageResolution', 'max-archive-entries': 'maxArchiveEntries',
  'max-uncompressed-bytes': 'maxUncompressedBytes', 'max-font-files': 'maxFontFiles',
  'max-font-file-bytes': 'maxFontFileBytes', 'max-loaded-font-bytes': 'maxLoadedFontBytes',
} as const

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    json: { type: 'boolean' }, input: { type: 'string' }, output: { type: 'string' }, sheet: { type: 'string' },
    'font-directory': { type: 'string', multiple: true }, 'initial-font-family': { type: 'string', multiple: true },
    'font-fallbacks': { type: 'string' },
    'output-dir': { type: 'string' }, pages: { type: 'string' }, range: { type: 'string' },
    dpi: { type: 'string' }, 'max-pages': { type: 'string' }, 'max-pixels': { type: 'string' }, 'max-dimension': { type: 'string' },
    ...Object.fromEntries(Object.keys(numericOptions).map(key => [key, { type: 'string' as const }])),
  } })
  const command = positionals[0] ?? ''
  if (positionals.length !== 1 || !['capabilities', 'convert', 'recalculate', 'render'].includes(command))
    throw new TypeError('Usage: dsoffice capabilities --json | render --input <file> --output-dir <fresh-directory> [--pages all|1,3] [--sheet <name> --range A1:D20] [--dpi 144] | convert --input <file> --output <file> [--sheet <name>] | recalculate --input <workbook> --output <xlsx|ods>')
  if (command === 'capabilities') {
    if (Object.keys(values).some(key => key !== 'json')) throw new TypeError('capabilities accepts only --json.')
    process.stdout.write(`${JSON.stringify({ runtime: await discoverRuntime(), conversions: CONVERSION_FORMATS,
      imageRendering: { inputs: IMAGE_FORMATS, output: 'png', officeBackend: 'libreoffice', pdfBackend: 'pdfium',
        pages: 'one-based physical pages or slides; all by default', worksheets: 'exact sheet plus optional A1 range; all visible data areas by default',
        maxPages: 100, maxPixels: 16777216, maxDimension: 8192 },
      csv: { sheet: 'exact name; required when the input has multiple worksheets', encoding: 'UTF-8', delimiter: ',' },
      recalculation: { inputs: ['xls', 'xlsx', 'ods'], outputs: ['xlsx', 'ods'], preservesFormulas: true },
      options: { limits: Object.keys(numericOptions), fonts: ['font-directory', 'initial-font-family', 'font-fallbacks'] },
    })}\n`)
    return
  }
  if (typeof values.input !== 'string') throw new TypeError('--input is required.')
  if (command === 'render') {
    if (typeof values['output-dir'] !== 'string' || values.output !== undefined) throw new TypeError('render requires --output-dir and does not accept --output.')
  } else {
    if (typeof values.output !== 'string') throw new TypeError('--input and --output are required.')
    if (['output-dir', 'pages', 'range', 'dpi', 'max-pages', 'max-pixels', 'max-dimension'].some(key => key in values)) throw new TypeError('Image selection options require the render command.')
  }
  const options: ConverterOptions = {}
  for (const [flag, key] of Object.entries(numericOptions)) {
    const value = (values as Record<string, string | boolean | string[] | undefined>)[flag]
    if (value !== undefined) {
      if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError(`--${flag} must be a positive integer.`)
      options[key] = Number(value)
    }
  }
  if (values['font-directory']) options.fontDirectories = (values['font-directory'] as string[]).map(path => resolve(path))
  if (values['initial-font-family']) options.initialFontFamilies = values['initial-font-family'] as string[]
  if (values['font-fallbacks']) options.fontFallbacks = JSON.parse(values['font-fallbacks'] as string) as string[][]
  const request = { inputPath: resolve(values.input), outputPath: typeof values.output === 'string' ? resolve(values.output) : '',
    ...(values.sheet === undefined ? {} : { sheet: values.sheet as string }) }
  if (command === 'recalculate' && request.sheet !== undefined) throw new TypeError('--sheet is supported only for CSV conversion.')
  const converter = await createConverter(options)
  const controller = new AbortController()
  const cancel = () => { controller.abort(new Error('LibreOffice CLI was cancelled.')) }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
    if (command === 'render') {
      const pageText = values.pages as string | undefined
      if (pageText !== undefined && pageText !== 'all' && !/^[1-9]\d*(?:,[1-9]\d*)*$/.test(pageText)) throw new TypeError('--pages must be all or comma-separated one-based page numbers.')
      const result = await converter.renderImages({ inputPath: request.inputPath, outputDir: resolve(values['output-dir'] as string),
        ...(pageText === undefined ? {} : { pages: pageText === 'all' ? 'all' : pageText.split(',').map(Number) }),
        ...(request.sheet === undefined ? {} : { sheet: request.sheet }),
        ...(values.range === undefined ? {} : { range: values.range as string }),
        ...(values.dpi === undefined ? {} : { dpi: Number(values.dpi) }),
        ...(values['max-pages'] === undefined ? {} : { maxPages: Number(values['max-pages']) }),
        ...(values['max-pixels'] === undefined ? {} : { maxPixels: Number(values['max-pixels']) }),
        ...(values['max-dimension'] === undefined ? {} : { maxDimension: Number(values['max-dimension']) }),
      }, controller.signal)
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return
    }
    const result = command === 'recalculate'
      ? await converter.recalculate(request, controller.signal) : await converter.convert(request, controller.signal)
    process.stdout.write(`${JSON.stringify({ ...result, outputPath: request.outputPath })}\n`)
  } finally {
    process.removeListener('SIGINT', cancel)
    process.removeListener('SIGTERM', cancel)
    await converter.dispose()
  }
}

try { await main() } catch (error) {
  process.stderr.write(`${JSON.stringify({ code: failureCode(error), error: error instanceof Error ? error.message : String(error) })}\n`)
  process.exitCode = 1
}
