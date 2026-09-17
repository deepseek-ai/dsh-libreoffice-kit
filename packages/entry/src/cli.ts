#!/usr/bin/env node
/** Offline CLI over the public converter; stdout contains one JSON result. */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { CONVERSION_FORMATS, createConverter, discoverRuntime } from './index.ts'
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
    ...Object.fromEntries(Object.keys(numericOptions).map(key => [key, { type: 'string' as const }])),
  } })
  const command = positionals[0] ?? ''
  if (positionals.length !== 1 || !['capabilities', 'convert', 'recalculate'].includes(command))
    throw new TypeError('Usage: libreoffice-kit capabilities --json | convert --input <file> --output <file> [--sheet <name>] | recalculate --input <workbook> --output <xlsx|ods>')
  if (command === 'capabilities') {
    if (Object.keys(values).some(key => key !== 'json')) throw new TypeError('capabilities accepts only --json.')
    process.stdout.write(`${JSON.stringify({ runtime: await discoverRuntime(), conversions: CONVERSION_FORMATS,
      csv: { sheet: 'exact name; required when the input has multiple worksheets', encoding: 'UTF-8', delimiter: ',' },
      recalculation: { inputs: ['xls', 'xlsx', 'ods'], outputs: ['xlsx', 'ods'], preservesFormulas: true },
      options: { limits: Object.keys(numericOptions), fonts: ['font-directory', 'initial-font-family', 'font-fallbacks'] },
    })}\n`)
    return
  }
  if (typeof values.input !== 'string' || typeof values.output !== 'string') throw new TypeError('--input and --output are required.')
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
  const request = { inputPath: resolve(values.input), outputPath: resolve(values.output),
    ...(values.sheet === undefined ? {} : { sheet: values.sheet as string }) }
  if (command === 'recalculate' && request.sheet !== undefined) throw new TypeError('--sheet is supported only for CSV conversion.')
  const converter = await createConverter(options)
  const controller = new AbortController()
  const cancel = () => { controller.abort(new Error('LibreOffice CLI was cancelled.')) }
  process.once('SIGINT', cancel)
  process.once('SIGTERM', cancel)
  try {
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
