/** Browser-safe family ordering and Fontconfig XML shared by both WASM adapters. */

/**
 * Case- and separator-insensitive family key used to compare names across sources.
 * @param value - Family, style, or postscript name as recorded by a document or font.
 * @returns The normalized key.
 */
export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replaceAll(/[\s_-]/g, '')
}
/**
 * Order named substitutions and their generic text family without excluding unlisted fonts.
 * @param requested - Original family names, in document order.
 * @param groups - Ordered family groups shared with Fontconfig aliases.
 * @param pitch - VCL pitch; one requests a monospaced fallback.
 * @param symbols - Whether symbol alternatives precede the generic fallback.
 * @returns distinct family names, with original requests first.
 */
export function fontFamilyPriority(requested: readonly string[], groups: readonly (readonly string[])[],
  pitch = 0, symbols = false): string[] {
  const original = requested.map(normalize)
  const matched = groups.filter(group => group.some(family => original.includes(normalize(family))))
  const generic = original.includes('monospace') || pitch === 1 ? 'monospace'
    : original.includes('serif') ? 'serif'
      : matched.flat().map(normalize).find(family => family === 'serif' || family === 'sansserif' || family === 'monospace') ?? 'sansserif'
  const families = [...requested, ...matched.flat()]
  for (const kind of symbols ? ['symbol', generic] : [generic]) {
    for (const group of groups) {
      if (group.some(family => normalize(family) === kind)) families.push(...group)
    }
  }
  const priority = new Map<string, string>()
  for (const family of families) {
    const name = normalize(family)
    if (!priority.has(name)) priority.set(name, family)
  }
  return [...priority.values()]
}

/**
 * Fontconfig XML restricts WASM discovery to imported originals in MEMFS.
 * @param families - Ordered family groups; the first name of each group is its canonical spelling.
 * @param requested - Additional family names the document declared.
 * @returns the fontconfig document written into the module's memory filesystem.
 */
export function memoryFontConfig(families: readonly (readonly string[])[], requested: Iterable<string> = []): string {
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  const names = [...new Map([...families.flatMap(group => group.slice(0, 1)), ...requested].map(name => [normalize(name), name])).values()]
  const aliases = names.map((name) => {
    const alternatives = fontFamilyPriority([name], families).filter(family => normalize(family) !== normalize(name))
    return `<alias><family>${escape(name)}</family><accept>${alternatives.map(family => `<family>${escape(family)}</family>`).join('')}</accept></alias>`
  })
  return `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/dsh-fonts</dir><cachedir>/dsh/font-cache</cachedir>${aliases.join('')}</fontconfig>`
}
