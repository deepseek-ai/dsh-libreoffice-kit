# Portable Host font source

[中文](README.zh.md)

`@deepseek-ai/libreoffice-kit-fonts` exports `createFontSource` and its font request/result types for Host-assisted browser document rendering. It runs on supported Node.js platforms using JavaScript and a packaged HarfBuzz WASM module. Its dependency tree contains no LibreOffice converter, native engine or Node LibreOffice WASM package.

Import `createFontSource` from this package, then call `resolve(request)` to select reusable per-face Unicode-script subsets and `read(id)` to obtain caller-owned sfnt bytes. The original family and style remain intact; each subset has a content-derived registration alias for the browser renderer. Call `dispose()` to terminate the private Worker and await its exit. Matching, cache limits and cancellation follow [the shared font API](../entry/README.md#browser-support-modules).

The implementation is maintained once under `packages/entry/src`. `pnpm build:fonts` builds those shared sources, stages only the two font runtime bundles and their public declarations, and copies the matching HarfBuzz resource, source recipe and license notices. `font-api.json` records the source/runtime hashes; `assets/font-subset.json` records the independently built subset module. Prepack verifies both inventories. Installation and font requests never compile or download resources.

This package and `@deepseek-ai/libreoffice-kit-browser` can be packed and qualified independently of the Node converter's native-platform release matrix; see [the preview candidate workflow](../../docs/building.md). Existing consumers of `@deepseek-ai/libreoffice-kit/fonts` can retain that equivalent export when they also need the Node converter package.
