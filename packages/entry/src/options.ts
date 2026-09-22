/** Validated deployment limits shared by native and Node WASM conversions. */
import type { ConverterOptions } from './index.ts'
import { systemFontDirectories } from './fonts.ts'

const SANS_CJK_FAMILIES = ['Microsoft YaHei', 'Microsoft YaHei UI', '微软雅黑', 'PingFang SC', 'Noto Sans CJK SC',
  'Noto Sans SC', 'Source Han Sans SC', 'SimHei', '黑体', 'Heiti SC', 'STHeiti']

/** Ordered family groups used when the caller supplies none. */
export const FONT_FALLBACKS: readonly (readonly string[])[] = [
  ['Calibri', 'Carlito'],
  ['Calibri Light', 'Carlito', 'Calibri'],
  ['Cambria', 'Caladea'],
  ['宋体', 'SimSun', 'NSimSun', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC'],
  ['黑体', 'SimHei', 'Heiti SC', 'STHeiti', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC'],
  ['微软雅黑', 'Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC'],
  ['楷体', 'KaiTi', 'Kaiti SC', 'STKaiti', 'LXGW WenKai'],
  ['仿宋', 'FangSong', 'STFangsong', 'Songti SC', 'Noto Serif CJK SC'],
  ['sans-serif', 'Arial', 'Liberation Sans', 'Helvetica', 'DejaVu Sans', 'Calibri', 'Calibri Light', 'Carlito',
    ...SANS_CJK_FAMILIES],
  ['serif', 'Times New Roman', 'Liberation Serif', 'Times', 'DejaVu Serif', 'Cambria', 'Caladea',
    'SimSun', 'NSimSun', '宋体', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC'],
  ['monospace', 'Courier New', 'Liberation Mono', 'DejaVu Sans Mono', 'Menlo', 'Monaco', 'Courier',
    'NSimSun', 'Noto Sans Mono CJK SC', ...SANS_CJK_FAMILIES],
  ['Symbol', 'Standard Symbols PS', 'Symbola', 'Segoe UI Symbol', 'Apple Symbols', 'FreeSerif', 'DejaVu Sans'],
]

/** Resolved limits and font settings used by every conversion of one converter. */
export interface ResolvedOptions {
  readonly timeoutMs: number
  readonly maxInputBytes: number
  readonly maxOutputBytes: number
  readonly maxImageResolution: number
  readonly maxArchiveEntries: number
  readonly maxUncompressedBytes: number
  readonly maxFontFiles: number
  readonly maxFontFileBytes: number
  readonly maxLoadedFontBytes: number
  readonly maxFontResolutionEntries: number
  readonly fontDirectories: string[]
  readonly includeOfficeFonts: boolean
  readonly fontFallbacks: string[][]
  readonly initialFontFamilies: string[]
}

const DEFAULT_LIMITS = {
  timeoutMs: 120_000, maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024,
  maxImageResolution: 144, maxArchiveEntries: 20_000, maxUncompressedBytes: 512 * 1024 * 1024,
  maxFontFiles: 20_000, maxFontFileBytes: 256 * 1024 * 1024, maxLoadedFontBytes: 512 * 1024 * 1024,
  maxFontResolutionEntries: 4096,
}

const FONT_COLLECTION_NAMES = ['fontDirectories', 'initialFontFamilies'] as const

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`)
  if (name.endsWith('Ms') && value > 0x7fffffff) throw new RangeError(`${name} exceeds the Node timer range.`)
  return value
}

function fontNames(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must contain nonempty strings.`)
  const names: string[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.includes('\0')) throw new TypeError(`${name} must contain nonempty strings.`)
    names.push(entry)
  }
  return names
}

function fontGroups(value: unknown): string[][] {
  if (!Array.isArray(value) || value.some(group => !Array.isArray(group) || group.length < 2 || group.some(entry => typeof entry !== 'string' || !entry.trim()))) throw new TypeError('fontFallbacks must contain groups of at least two nonblank font names.')
  return (value as string[][]).map(group => [...group])
}

/**
 * Resolve defaults once; reject misspelled options and malformed font settings.
 * @param input - Caller options; absent fields keep their documented default.
 * @returns The validated limits and font settings, with caller arrays copied.
 * @throws TypeError for a non-object argument or an unknown option name.
 * @throws RangeError for a limit outside the positive safe-integer timer range.
 */
export function resolveOptions(input: ConverterOptions = {}): ResolvedOptions {
  const callerOptions: unknown = input
  if (callerOptions === null || typeof callerOptions !== 'object' || Array.isArray(callerOptions)) throw new TypeError('Converter options must be an object.')
  const merged: Record<string, unknown> = { ...DEFAULT_LIMITS, fontDirectories: systemFontDirectories(),
    fontFallbacks: FONT_FALLBACKS, initialFontFamilies: [], ...input }
  for (const key of Object.keys(input)) if (!(key in DEFAULT_LIMITS) && !(FONT_COLLECTION_NAMES as readonly string[]).includes(key) && key !== 'fontFallbacks') {
    throw new TypeError(`Unknown converter option: ${key}`)
  }
  return {
    timeoutMs: positiveSafeInteger(merged.timeoutMs, 'timeoutMs'),
    maxInputBytes: positiveSafeInteger(merged.maxInputBytes, 'maxInputBytes'),
    maxOutputBytes: positiveSafeInteger(merged.maxOutputBytes, 'maxOutputBytes'),
    maxImageResolution: positiveSafeInteger(merged.maxImageResolution, 'maxImageResolution'),
    maxArchiveEntries: positiveSafeInteger(merged.maxArchiveEntries, 'maxArchiveEntries'),
    maxUncompressedBytes: positiveSafeInteger(merged.maxUncompressedBytes, 'maxUncompressedBytes'),
    maxFontFiles: positiveSafeInteger(merged.maxFontFiles, 'maxFontFiles'),
    maxFontFileBytes: positiveSafeInteger(merged.maxFontFileBytes, 'maxFontFileBytes'),
    maxLoadedFontBytes: positiveSafeInteger(merged.maxLoadedFontBytes, 'maxLoadedFontBytes'),
    maxFontResolutionEntries: positiveSafeInteger(merged.maxFontResolutionEntries, 'maxFontResolutionEntries'),
    fontDirectories: fontNames(merged.fontDirectories, 'fontDirectories'),
    includeOfficeFonts: input.fontDirectories === undefined,
    initialFontFamilies: fontNames(merged.initialFontFamilies, 'initialFontFamilies'),
    fontFallbacks: fontGroups(merged.fontFallbacks),
  }
}
