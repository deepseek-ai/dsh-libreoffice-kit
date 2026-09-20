/** Named compatibility aliases and generic defaults shared by font consumers. */
const SANS_CJK_FAMILIES = ['Microsoft YaHei', 'Microsoft YaHei UI', '微软雅黑', 'PingFang SC', 'Noto Sans CJK SC',
  'Noto Sans SC', 'Source Han Sans SC', 'SimHei', '黑体', 'Heiti SC', 'STHeiti']
const SANS_KOREAN_FAMILIES = ['Malgun Gothic', '맑은 고딕', 'Apple SD Gothic Neo', 'Noto Sans CJK KR',
  'Noto Sans KR', 'Source Han Sans K', 'NanumGothic', 'AppleGothic', 'Dotum', '돋움']
const SERIF_KOREAN_FAMILIES = ['Batang', '바탕', 'AppleMyungjo', 'Noto Serif CJK KR',
  'Noto Serif KR', 'Source Han Serif K', 'NanumMyeongjo']

/** Ordered family groups used when the caller supplies none. */
export const DEFAULT_FONT_FALLBACKS: readonly (readonly string[])[] = [
  ['Calibri', 'Carlito'],
  ['Calibri Light', 'Carlito', 'Calibri'],
  ['Cambria', 'Caladea'],
  ['宋体', 'SimSun', 'NSimSun', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC'],
  ['黑体', 'SimHei', 'Heiti SC', 'STHeiti', 'Noto Sans CJK SC', 'Noto Sans SC', 'Source Han Sans SC'],
  ['微软雅黑', 'Microsoft YaHei', 'Microsoft YaHei UI', 'PingFang SC', 'Noto Sans CJK SC', 'Noto Sans SC'],
  ['楷体', 'KaiTi', 'Kaiti SC', 'STKaiti', 'LXGW WenKai'],
  ['仿宋', 'FangSong', 'STFangsong', 'Songti SC', 'Noto Serif CJK SC'],
  ['sans-serif', 'Arial', 'Liberation Sans', 'Helvetica', 'DejaVu Sans', 'Calibri', 'Calibri Light', 'Carlito',
    ...SANS_CJK_FAMILIES, ...SANS_KOREAN_FAMILIES],
  ['serif', 'Times New Roman', 'Liberation Serif', 'Times', 'DejaVu Serif', 'Cambria', 'Caladea',
    'SimSun', 'NSimSun', '宋体', 'Songti SC', 'STSong', 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC',
    ...SERIF_KOREAN_FAMILIES],
  ['monospace', 'Courier New', 'Liberation Mono', 'DejaVu Sans Mono', 'Menlo', 'Monaco', 'Courier',
    'NSimSun', 'Noto Sans Mono CJK SC', 'Noto Sans Mono CJK KR', ...SANS_CJK_FAMILIES, ...SANS_KOREAN_FAMILIES],
  ['Symbol', 'Standard Symbols PS', 'Symbola', 'Segoe UI Symbol', 'Apple Symbols', 'FreeSerif', 'DejaVu Sans'],
]

