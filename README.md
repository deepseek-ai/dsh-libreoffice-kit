---
description: "Font-friendly OOXML-to-PDF conversion in Node.js, with prebuilt LibreOffice engines."
kind: "package-library"
---
# @deepseek-ai/libreoffice-kit

English | [中文](README.zh.md)

## Current goal

**Font-friendly OOXML → PDF conversion in Node.js.** Version `0.0.1` exposes a standalone Node API for converting local `.docx`, `.xlsx`, and `.pptx` files into PDFs using prebuilt LibreOffice engines. This repository owns the API, font loading, pinned LibreOffice source, patches, native helper, Node WebAssembly engine, and release packages.

The priorities are document layout and readable text, explicit control over available fonts and substitutions, and an engine that applications can bundle and run offline. Size reduction serves that goal: retain the import, layout, drawing, and PDF-export machinery these documents need while removing unrelated desktop features and resources.

The current API supports these three OOXML formats and PDF output. Use it in a Node.js service, a desktop application, or a document-processing job. Applications manage their own authorization, storage, and preview interfaces.

## Quick start

Requires Node.js **22.19.0 or newer**. Install the `0.0.1` package with its optional engines:

```sh
npm install @deepseek-ai/libreoffice-kit@0.0.1
```

```js
import { createConverter } from '@deepseek-ai/libreoffice-kit';

const converter = await createConverter({
  timeoutMs: 120_000,
  // Omit to discover fonts in conventional system/user directories.
  // fontDirectories: ['/absolute/path/to/fonts'],
});
try {
  const result = await converter.render({
    inputPath: '/private/work/document.docx',
    outputPath: '/private/work/document.pdf',
  });
  console.log(result.backend, result.missingFonts);
} finally {
  await converter.dispose();
}
```

Supply absolute paths in caller-owned private directories; the output must not already exist. The PDF is written to `outputPath`, and `render` returns the selected backend and missing-font names. Each render owns a fresh native process or Node worker and private profile. Renders on one converter are serialized; cancellation and disposal wait for engine exit and cleanup. See the [Node API](packages/entry/README.md) for cancellation, errors, and resource limits.

## What “font-friendly” means in 0.0.1

- **Use available fonts.** The API discovers conventional system/user font directories, or indexes the roots supplied through `fontDirectories`. Custom roots replace the default list. `fontkit` reads font metadata and glyph coverage; selected files are passed to the engine as original font bytes.
- **Preserve requested families when available.** Exact installed families take priority, including handwriting and decorative fonts. WASM font requests also carry weight and italic information so matching installed faces can be selected; the catalog can supply additional fonts for missing glyphs.
- **Make substitutions configurable.** Default `fontFallbacks` cover common Latin and Simplified Chinese families, including Carlito for missing Calibri and Caladea for missing Cambria. Caller-supplied groups replace the defaults. These preferences only select available fonts; they do not install them. See the [default groups](packages/entry/src/options.ts).
- **Expose missing families and font budgets.** `missingFonts` reports unavailable families declared in readable document XML. `maxFontFiles`, `maxFontFileBytes`, and `maxLoadedFontBytes` bound indexing and explicit imports. A converter reuses its first font metadata snapshot; recreate it after changing fonts.

No font collection is bundled or downloaded. Deployments supply fonts appropriate to their documents and redistribution rights; minimal containers need fonts installed or a configured font directory. WASM uses only imported fonts and rejects conversion with `unavailable` if none are usable. Native macOS and Windows can also use OS-managed fonts.

This improves control over font choice, but does not guarantee identical output to Microsoft Office or between engines. Native LibreOffice resolves installed originals and metric-compatible families before configured substitutions, and handles face selection itself. Font metrics can change line breaks and pagination; `missingFonts` is not a complete missing-glyph report. Comparing engines requires identical document bytes, fonts, and export options.

## Engines and distribution

The [Node package manifest](packages/entry/package.json) declares the engines for `0.0.1`:

| Engine | Role |
| --- | --- |
| `@deepseek-ai/libreoffice-kit-darwin-arm64` | Native helper for macOS on Apple Silicon. |
| `@deepseek-ai/libreoffice-kit-win32-x64` | Native helper for Windows x64; requires the Microsoft Visual C++ v14 x64 Redistributable. |
| `@deepseek-ai/libreoffice-kit-wasm` | Shared Node WASM engine when no compatible native package is selected. |

Other native directories are development recipes, not additional released targets. The shared WASM package has no npm OS/CPU/libc restriction; that declaration alone does not certify every host. Both engines perform layout and PDF serialization on the CPU.

Selection uses installed OS/CPU/libc packages. A missing matching native package, unknown Linux libc, or host glibc below the installed native package's recorded minimum selects installed WASM. If WASM is required but absent, `createConverter` rejects with `unavailable`. A corrupt or unusable installed engine rejects; conversion failures do not switch engines.

The Node API and engines share the kit version. Installation uses prepared packages; no install hook or conversion compiles LibreOffice, downloads extra engines, or discovers the user's LibreOffice installation. npm distributes standard `.tgz` packages. GitHub Release engine downloads use verified XZ transfer archives for application builders to prepare and bundle. See [packaging](docs/packaging.md) and [release procedures](docs/building.md) for these distribution paths and installed-conversion checks.

## What was reduced, and why

The `0.0.1` recipes reduce build components, installed resources, and transfer size separately:

| Layer | Changes in the code | Reason |
| --- | --- | --- |
| Native build | Disable Java/Python, scripting and extensions, Base database connectivity, PDF import, help/dictionaries, galleries/templates/icon themes, remote control, updates, and unused curl/WebDAV/CMIS/LDAP integrations. | Local OOXML → PDF needs document import and PDF export; desktop automation, database access, PDF input, and online services add dependencies outside that path. |
| Native payload | Remove the verified duplicate macOS `urelibs` alias, SDK tools, launchers, Quick Look/Spotlight resources, disabled libraries, Basic/Python scripts, notebookbars, menus, and toolbars. Strip nonessential symbols while preserving dynamic exports; restore and verify macOS signatures. | Avoid shipping duplicate libraries and desktop/development resources in an application conversion engine. |
| WASM build and payload | Build Writer, Calc, and Impress for headless Node workers, with Java/Python, bundled fonts, OpenCL/OpenGL, and Skia disabled. Prune icon archives, notebookbars, menus/toolbars, Android sample documents, splash images, and shell resources from `soffice.data`. | Keep the document engines and CPU rendering path while reducing resources loaded into the WASM filesystem. The resource-pruning pass preserves retained bytes and metadata, regenerates offsets, and leaves the loader and compiled module unchanged. |
| Font payload | Omit bundled font collections; load original font files supplied by the deployment at runtime. | Avoid a fixed font payload and let applications choose the fonts needed for their documents, including CJK coverage and Office-compatible alternatives. |
| Release transfer | Use XZ for GitHub Release engine downloads, with separate size/hash checks for the compressed envelope and exact installation tar. | Reduce transfer bytes without changing installed engine contents. This is separate from payload pruning and from npm's `.tgz` format. |

The authoritative recipes are [native configuration](engine/native/configure.mjs), [native payload pruning](scripts/slim-native.mjs), [WASM configuration](engine/wasm-source/autogen.input), and [WASM resource pruning](engine/wasm-source/slim.mjs).

Writer, Calc, Impress, OOXML filters, PDF export, shared layout/drawing libraries, charts, ICU and language resources remain. The native `en-US` build language selects UI resources; it does not restrict document text to English. Required runtime configuration and some UI resources remain because document services still use them. Matching source recipes, patches, hashes, and license notices travel with every engine package. These retained dependencies explain why the result is still a substantial document engine.

### Recorded size and fidelity checks

The existing local candidate measurements compare the preceding `0.1.2` gzip packages with the independently versioned `0.0.1` XZ packages. They combine payload changes and compression changes; the download reduction is not solely code removal. These are historical candidate measurements, not current npm download sizes. MB means 1,000,000 bytes; unpacked size sums regular files and excludes filesystem allocation and dependency packages.

| Engine | Previous download | 0.0.1 download | Reduction | Previous unpacked | 0.0.1 unpacked |
| --- | ---: | ---: | ---: | ---: | ---: |
| macOS ARM64 | 98.85 MB | 60.49 MB | 38.81% | 301.04 MB | 269.43 MB |
| Node WASM | 56.47 MB | 35.85 MB | 36.51% | 210.24 MB | 190.64 MB |

The recorded local macOS ARM64 check installed the same candidate offline with native and WASM selection. Six synthetic DOCX/XLSX/PPTX documents per engine, covering Chinese/English text, tables, formulas, and images, retained identical extracted text, page counts, and 96-DPI rendered pixels against the preceding packages. This covers those fixtures and that host; it does not establish universal document fidelity or other-platform qualification. Runtime suites also cover external-link suppression, font substitutions, limits, and cancellation; [release qualification](docs/building.md) requires installed-engine evidence.

## Development

[Native sources](engine/native/) and the [Node WASM recipe](engine/wasm-source/README.md) use the same LibreOffice revision pinned by the `engine/core` submodule. [.gitmodules](.gitmodules) owns its upstream URL and the gitlink owns its commit. Checkout scripts keep that submodule pristine and create disposable, patchable trees under ignored `.build/` directories. This repository owns component selection and the complete packaging recipe; each engine ships the matching source and license materials.

Run the repository checks without building LibreOffice:

```sh
pnpm verify:metadata
pnpm test
pnpm test:packaging
```

Real engine tests additionally require `pnpm run build:adapter`, prepared engine payloads, and `LIBREOFFICE_RUNTIME_ENTRY` pointing to the absolute path of `packages/entry/lib/index.js`. Build platforms sequentially with explicit parallelism suited to CPU and memory; `pnpm gha:matrix` shows the CI matrix. Build output remains ignored.

[Benchmarks](benchmarks/README.md) measure the public disk API in separate native and WASM installations and distinguish first font indexing from converter reuse. Use the same source revision, documents, font roots, and PDF options for comparisons; frontend transport and painting are separate measurements.
