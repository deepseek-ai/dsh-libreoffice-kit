/** Complete Unicode Script partitions with shared punctuation, marks and variation selectors. */
import * as publishedProperties from '@unicode/unicode-17.0.0'
import variationSelectors from '@unicode/unicode-17.0.0/Binary_Property/Variation_Selector/code-points.mjs'

// This release exports a default object at runtime but declares named property arrays.
const properties = (publishedProperties as unknown as { default: { Script: readonly string[] } }).default
interface UnicodeRange { readonly begin: number; readonly end: number }

/** Unicode data and partition generation participate in every subset request identity. */
export const FONT_PARTITION_VERSION = 'unicode-17.0.0-data-2.0.7-script-v1'
/** A shared metadata/punctuation subset used before layout requests any script. */
export const FONT_BASE_SCRIPT = 'Common'

interface ScriptData {
  readonly names: readonly string[]
  readonly primary: Uint16Array
  readonly extensions: ReadonlyMap<string, readonly UnicodeRange[]>
}
let loaded: Promise<ScriptData> | undefined

function scriptData(): Promise<ScriptData> {
  return loaded ??= (async () => {
    const names = properties.Script
    const primary = new Uint16Array(0x110000)
    const extensions = new Map<string, readonly UnicodeRange[]>()
    await Promise.all(names.map(async (name, index) => {
      const [script, extended] = await Promise.all([
        import(`@unicode/unicode-17.0.0/Script/${name}/ranges.mjs`) as Promise<{ default: UnicodeRange[] }>,
        import(`@unicode/unicode-17.0.0/Script_Extensions/${name}/ranges.mjs`) as Promise<{ default: UnicodeRange[] }>,
      ])
      for (const range of script.default) primary.fill(index, range.begin, range.end)
      extensions.set(name, extended.default)
    }))
    return { names, primary, extensions }
  })()
}

/**
 * Select stable whole-script partitions for a request; shared characters use the base partition.
 * @param points - Unicode scalars requested by layout.
 * @returns deterministic Unicode script names, including Unknown for private-use or unassigned characters.
 */
export async function requestedFontScripts(points: readonly number[]): Promise<string[]> {
  const data = await scriptData()
  const scripts = new Set(points.map(point => data.names[data.primary[point]!]!))
  scripts.delete('Common')
  scripts.delete('Inherited')
  return scripts.size === 0 ? [FONT_BASE_SCRIPT] : [...scripts].sort()
}

/**
 * Retain source characters in a script's Script_Extensions, plus Common/Inherited and variation selectors.
 * @param points - Character repertoire of one physical font face.
 * @param script - Name returned by requestedFontScripts.
 * @returns Unicode set for HarfBuzz's layout and composite-glyph closure.
 */
export async function fontScriptCodePoints(points: readonly number[], script: string): Promise<number[]> {
  const data = await scriptData()
  const ranges = data.extensions.get(script)!
  const selected = points.filter((point) => {
    const primary = data.names[data.primary[point]!]
    return primary === 'Common' || primary === 'Inherited'
      || (script !== FONT_BASE_SCRIPT && ranges.some(range => point >= range.begin && point < range.end))
  })
  return [...new Set([...selected, ...variationSelectors])].sort((left, right) => left - right)
}
