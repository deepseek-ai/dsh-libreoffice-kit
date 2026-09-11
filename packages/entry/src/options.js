/** Validated deployment limits shared by native and Node WASM conversions. */
import { systemFontDirectories } from './fonts.js';

export const FONT_FALLBACKS = [
  ['sans-serif', 'Arial', 'Liberation Sans', 'Helvetica', 'DejaVu Sans'],
  ['serif', 'Times New Roman', 'Liberation Serif', 'Times', 'DejaVu Serif'],
  ['monospace', 'Courier New', 'Liberation Mono', 'Courier', 'DejaVu Sans Mono', 'Menlo', 'Monaco'],
  ['宋体', 'SimSun', 'NSimSun', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC'],
  ['黑体', 'SimHei', 'Heiti SC', 'STHeiti', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC'],
  ['微软雅黑', 'Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC'],
  ['楷体', 'KaiTi', 'Kaiti SC', 'STKaiti', 'LXGW WenKai'],
  ['仿宋', 'FangSong', 'STFangsong', 'Songti SC', 'Noto Serif CJK SC'],
  ['Calibri', 'Carlito', 'Arial', 'Helvetica', 'Liberation Sans', 'DejaVu Sans'],
  ['Cambria', 'Caladea', 'Times New Roman', 'Times', 'Liberation Serif', 'DejaVu Serif'],
  ['Symbol', 'Standard Symbols PS', 'Symbola', 'Segoe UI Symbol', 'Apple Symbols', 'FreeSerif', 'DejaVu Sans'],
];

/** Resolve defaults once; reject misspelled options and unsupported engine choices. */
export function resolveOptions(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Converter options must be an object.');
  const defaults = {
    timeoutMs: 120_000, maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 128 * 1024 * 1024,
    maxImageResolution: 144, maxArchiveEntries: 20_000, maxUncompressedBytes: 512 * 1024 * 1024,
    maxFontFiles: 20_000, maxFontFileBytes: 256 * 1024 * 1024, maxLoadedFontBytes: 512 * 1024 * 1024,
    maxGpuBytes: 256 * 1024 * 1024, gpuTimeoutMs: 5_000, gpuInitializationTimeoutMs: 10_000,
  };
  const result = { ...defaults, fontDirectories: systemFontDirectories(), fontFallbacks: FONT_FALLBACKS,
    initialFontFamilies: [], gpu: 'auto', ...input };
  for (const key of Object.keys(input)) if (!(key in defaults) && !['fontDirectories', 'fontFallbacks', 'initialFontFamilies', 'gpu'].includes(key)) {
    throw new TypeError(`Unknown converter option: ${key}`);
  }
  for (const name of Object.keys(defaults)) {
    if (!Number.isSafeInteger(result[name]) || result[name] < 1) throw new RangeError(`${name} must be a positive safe integer.`);
    if (name.endsWith('Ms') && result[name] > 0x7fffffff) throw new RangeError(`${name} exceeds the Node timer range.`);
  }
  for (const name of ['fontDirectories', 'initialFontFamilies']) {
    if (!Array.isArray(result[name]) || result[name].some(value => typeof value !== 'string' || value.length === 0 || value.includes('\0'))) throw new TypeError(`${name} must contain nonempty strings.`);
    result[name] = [...result[name]];
  }
  if (!Array.isArray(result.fontFallbacks) || result.fontFallbacks.some(group => !Array.isArray(group) || group.length < 2 || group.some(value => typeof value !== 'string' || !value))) throw new TypeError('fontFallbacks must contain groups of at least two font names.');
  result.fontFallbacks = result.fontFallbacks.map(group => [...group]);
  if (!['auto', 'off', 'webgpu', 'webgl2', 'webgl1'].includes(result.gpu)) throw new TypeError('gpu must be auto, off, webgpu, webgl2, or webgl1.');
  return result;
}
