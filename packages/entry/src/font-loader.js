/** Conversion-local font imports and exact-family diagnostics. */
import { extname } from 'node:path';
import { SystemFontCatalog, normalize, readFont } from './fonts.js';

/** Build the metadata catalog inside a cancellable conversion worker. */
export function createFontLoader(options, document, install, faces) {
  const catalog = new SystemFontCatalog({ faces, fallbackFamilies: options.fontFallbacks });
  const loaded = new Map();
  const resolved = new Map();
  const missing = new Map();
  const signal = new AbortController().signal;
  let bytes = 0;
  return {
    get missingFonts() { return [...missing.values()]; },
    get files() { return [...loaded.values()]; },
    resolve(request) {
      const key = JSON.stringify(request);
      if (resolved.has(key)) return resolved.get(key);
      const match = catalog.match(request, signal);
      if (match.missingFamily && document.families.has(normalize(match.missingFamily))) missing.set(normalize(match.missingFamily), match.missingFamily);
      const paths = match.fonts.map(face => {
        if (!loaded.has(face.path)) {
          if (bytes + face.size > options.maxLoadedFontBytes) throw new Error('Imported fonts exceed maxLoadedFontBytes.');
          const path = install(`${loaded.size}${extname(face.path)}`, readFont(face));
          bytes += face.size;
          loaded.set(face.path, path);
        }
        return loaded.get(face.path);
      });
      resolved.set(key, paths);
      return paths;
    },
  };
}

/** Supply native imports and seed WASM's first usable default font. */
export function preloadFonts(loader, options, document, native = false) {
  const families = [...options.initialFontFamilies, ...(native ? document.families.values() : []), 'sans-serif'];
  for (const family of families) loader.resolve({ family, style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: native ? document.codePoints : [] });
}

/** Fontconfig XML restricts WASM discovery to imported originals in MEMFS. */
export function memoryFontConfig(families) {
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  return `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/dsh-fonts</dir><cachedir>/dsh/font-cache</cachedir>${families.map(([name, ...rest]) => `<alias><family>${escape(name)}</family><prefer>${rest.map(family => `<family>${escape(family)}</family>`).join('')}</prefer></alias>`).join('')}</fontconfig>`;
}
