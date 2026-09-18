/** Validated document operations shared by the public API, workers, and CLI. */
import { extname, isAbsolute, resolve } from 'node:path'
import { ConversionError } from './errors.ts'

/** Conversions supported by the bundled Writer, Calc, and Impress components. */
export const CONVERSION_FORMATS = [
  { inputs: ['doc', 'docx', 'odt'], outputs: ['pdf', 'docx', 'odt', 'txt'] },
  { inputs: ['xls', 'xlsx', 'ods'], outputs: ['pdf', 'xlsx', 'ods', 'csv'] },
  { inputs: ['ppt', 'pptx', 'odp'], outputs: ['pdf', 'pptx', 'odp'] },
] as const

/** Absolute input and fresh output paths, with an exact worksheet name for CSV export. */
export interface ConversionRequest {
  readonly inputPath: string
  readonly outputPath: string
  /** CSV only; required for a workbook containing multiple sheets. */
  readonly sheet?: string
}

/** Engine operation after extension and parameter validation. */
export interface ConversionSpec {
  readonly inputPath: string
  readonly outputPath: string
  readonly extension: string
  readonly format: string
  readonly recalculate: boolean
  readonly sheet?: string
}

/**
 * Validate paths and the format matrix before file access or queue admission.
 * @param request - Public conversion parameters.
 * @param operation - PDF compatibility entry, general conversion, or workbook recalculation.
 * @returns The explicit engine operation.
 */
export function resolveConversion(request: ConversionRequest, operation: 'render' | 'convert' | 'recalculate'): ConversionSpec {
  if (!request || typeof request.inputPath !== 'string' || typeof request.outputPath !== 'string'
    || !isAbsolute(request.inputPath) || !isAbsolute(request.outputPath) || request.inputPath.includes('\0') || request.outputPath.includes('\0'))
    throw new TypeError('inputPath and outputPath must be absolute filesystem paths.')
  if (resolve(request.inputPath) === resolve(request.outputPath)) throw new TypeError('Input and output paths must differ.')
  const extension = extname(request.inputPath).slice(1).toLowerCase()
  const format = operation === 'render' ? 'pdf' : extname(request.outputPath).slice(1).toLowerCase()
  const family = CONVERSION_FORMATS.find(group => (group.inputs as readonly string[]).includes(extension))
  if (!family || !(family.outputs as readonly string[]).includes(format))
    throw new ConversionError('unsupported-format', `Unsupported conversion: ${extension || '(no input extension)'} → ${format || '(no output extension)'}.`)
  if (operation === 'recalculate' && (!['xls', 'xlsx', 'ods'].includes(extension) || !['xlsx', 'ods'].includes(format)))
    throw new ConversionError('unsupported-format', 'Recalculation requires XLS, XLSX, or ODS input and XLSX or ODS output.')
  if (request.sheet !== undefined && (format !== 'csv' || typeof request.sheet !== 'string' || !request.sheet.trim() || request.sheet.includes('\0')))
    throw new TypeError('sheet must be a nonempty exact worksheet name and is supported only for CSV output.')
  return { inputPath: request.inputPath, outputPath: request.outputPath, extension, format,
    recalculate: operation === 'recalculate', ...(request.sheet === undefined ? {} : { sheet: request.sheet }) }
}

/**
 * Reject an engine output with an incorrect container signature.
 * @param bytes - Complete bounded output.
 * @param format - Requested output suffix.
 */
export function validateOutput(bytes: Uint8Array, format: string): void {
  if (format === 'pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new ConversionError('invalid-output', 'LibreOffice did not produce a PDF.')
  if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(format)
    && (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4))
    throw new ConversionError('invalid-output', `LibreOffice did not produce a ${format} archive.`)
}
