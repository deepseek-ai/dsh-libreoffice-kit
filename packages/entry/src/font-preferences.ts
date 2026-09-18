/** Script-aware installed-font preferences; synchronous for LibreOffice's VCL callback. */
import { DEFAULT_FONT_FALLBACKS } from './default-fonts.ts'
import { fontFamilyPriority, normalize } from './font-config.ts'
import { FONTCONFIG_FONTS, SCRIPT_EXTENSIONS, SCRIPT_NAMES, SCRIPT_RANGES, WINDOWS_FONTS } from './font-preferences-data.ts'
import type { FontMatchRequest } from './font-request.ts'

const genericNames = new Set(['serif', 'sansserif', 'monospace', 'systemui', 'symbol', 'cursive', 'fantasy'])

function scriptOf(point: number): string {
  let left = 0, right = SCRIPT_RANGES.length
  while (left < right) {
    const middle = (left + right) >>> 1
    if (SCRIPT_RANGES[middle]![0] <= point) left = middle + 1
    else right = middle
  }
  const range = SCRIPT_RANGES[left - 1]
  return range !== undefined && point < range[1] ? SCRIPT_NAMES[range[2]]! : 'Unknown'
}

/**
 * Partition missing scalars by Unicode 17; shared marks follow a compatible script when present.
 * @param points - Missing scalars, in engine order.
 * @returns stable script groups without splitting Script_Extensions marks from their base.
 */
export function fontScriptGroups(points: readonly number[]): Map<string, number[]> {
  const scripts = new Set(points.map(scriptOf).filter(script => script !== 'Common' && script !== 'Inherited'))
  const groups = new Map<string, number[]>()
  for (const point of points) {
    let script = scriptOf(point)
    if (script === 'Common' || script === 'Inherited') {
      const extension = SCRIPT_EXTENSIONS.find(([first, end, index]) => point >= first && point < end && scripts.has(SCRIPT_NAMES[index]!))
      script = extension === undefined ? 'Common' : SCRIPT_NAMES[extension[2]]!
    }
    const group = groups.get(script) ?? []
    group.push(point)
    groups.set(script, group)
  }
  return groups
}

/**
 * Recognize CJK regional font names, including platform families without a region suffix.
 * @param family - Family or alias.
 * @returns Noto region key, when the family identifies a regional design.
 */
export function fontRegion(family: string): string | undefined {
  const name = normalize(family)
  if (/malgun|gulim|dotum|batang|nanum|applegothic|applesdgothic|applemyungjo|맑은|돋움|바탕/.test(name)) return 'kr'
  if (/hiragino|meiryo|yugothic|yumincho|msp?gothic|msp?mincho|ipam|ipaex|sazanami|kochi|umeplus/.test(name)) return 'jp'
  if (/jhenghei|mingliu|pmingli/.test(name)) return 'tc'
  if (/yahei|simsun|nsimsun|simhei|stsong|stheiti|wenquanyi|宋体|黑体|微软雅黑/.test(name)) return 'sc'
  return /(?:cjk|sans|serif|songti|pingfang|heiti|sourcehan)(sc|tc|hk|jp|kr|k)(?:$|regular|bold|light)/.exec(name)?.[1]?.replace(/^k$/, 'kr')
}

function hanRegion(request: FontMatchRequest, scripts: Iterable<string>): string | undefined {
  const language = request.language.toLowerCase()
  if (/^ja(?:-|$)/.test(language)) return 'jp'
  if (/^ko(?:-|$)/.test(language)) return 'kr'
  if (/^zh(?:-|$)/.test(language)) return /hk|mo/.test(language) ? 'hk' : /hant|tw/.test(language) ? 'tc' : 'sc'
  for (const family of request.family.split(';')) { const region = fontRegion(family); if (region) return region }
  const values = new Set(scripts)
  if (values.has('Hiragana') || values.has('Katakana')) return 'jp'
  if (values.has('Hangul')) return 'kr'
  if (values.has('Bopomofo')) return 'tc'
  return undefined
}

/**
 * Separate explicit aliases from generic fallback so script preferences cannot override user intent.
 * @param request - VCL request.
 * @param groups - Configured named and generic aliases.
 * @param script - Current Unicode script.
 * @param scripts - Other scripts in this same request.
 * @param platform - Host OS owning the font catalog.
 * @returns explicit names, ordered body candidates, regional preference and decorative policy.
 */
export function fontPreferences(request: FontMatchRequest, groups: readonly (readonly string[])[], script: string,
  scripts: Iterable<string>, platform: string = process.platform) {
  const requested = request.family.split(';').map(value => value.trim()).filter(Boolean)
  const keys = requested.map(normalize)
  const matched = groups.filter(group => group.some(name => keys.includes(normalize(name))))
  const generic = request.pitch === 1 || keys.includes('monospace') ? 'monospace'
    : keys.includes('serif') ? 'serif'
      : matched.flat().map(normalize).find(name => name === 'serif' || name === 'sansserif' || name === 'monospace') ?? 'sansserif'
  const custom = groups.filter(group => !DEFAULT_FONT_FALLBACKS.some(value => JSON.stringify(value) === JSON.stringify(group)))
  const explicit = [...requested.filter(name => !genericNames.has(normalize(name))),
    ...matched.filter(group => !group.some(name => genericNames.has(normalize(name)))).flat(),
    ...custom.filter(group => group.some(name => normalize(name) === generic || keys.includes(normalize(name)))).flat()]
    .filter(name => !genericNames.has(normalize(name))).map(normalize)
  const region = script === 'Hangul' ? 'kr' : script === 'Hiragana' || script === 'Katakana' ? 'jp'
    : script === 'Bopomofo' ? 'tc' : script === 'Han' ? hanRegion(request, scripts) : undefined
  const scriptKey = script === 'Han' ? region === 'sc' ? 'simplified_han' : region === 'tc' || region === 'hk' ? 'traditional_han'
    : region === 'jp' ? 'hiragana' : region === 'kr' ? 'hangul' : 'han'
    : script === 'Old_Turkic' ? 'orkhon' : script.toLowerCase()
  const legacy = fontFamilyPriority(requested, groups, request.pitch, script === 'Common' && request.codePoints.some(point => /\p{Symbol}/u.test(String.fromCodePoint(point))))
  const config = FONTCONFIG_FONTS[generic === 'sansserif' ? 'sans-serif' : generic] ?? []
  const windows = WINDOWS_FONTS[scriptKey] ?? []
  // Chromium's CJK arrays are sans faces. Serif/mono use Fontconfig's separate categories first.
  const candidates = script === 'Latin' || script === 'Greek' || script === 'Cyrillic' || script === 'Common'
    ? [...legacy, ...config, ...windows]
    : platform === 'win32' && generic === 'sansserif' ? [...windows, ...config, ...legacy] : [...config, ...windows, ...legacy]
  return { explicit: [...new Set(explicit)], candidates: [...new Set(candidates.map(normalize))], region,
    // In cursive writing systems, an OS/2 script class describes normal body typography.
    penalizeDecorative: ['Latin', 'Greek', 'Cyrillic', 'Hangul', 'Han', 'Hiragana', 'Katakana', 'Bopomofo'].includes(script) }
}
