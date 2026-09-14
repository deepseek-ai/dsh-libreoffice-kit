# @deepseek-ai/libreoffice-kit

English | [中文](README.zh.md)

Convert local DOCX, XLSX, and PPTX files to PDF in Node.js with prebuilt LibreOffice engines. Use the same API in a server, desktop application, or document-processing job, with configurable fonts, cancellation, and resource limits.

## Installation and usage

Install with Node.js 22.19.0 or newer:

```sh
npm install @deepseek-ai/libreoffice-kit@0.0.1
```

The package optionally installs the shared WASM engine, the macOS ARM64 engine, and the Windows x64 engine. `createConverter` selects an installed OS/architecture/libc engine; an absent matching native package or a known host glibc below the installed engine’s minimum selects WASM. Invalid installed engines and conversion failures reject the request.

```js
import { createConverter } from '@deepseek-ai/libreoffice-kit';

const converter = await createConverter({ timeoutMs: 120_000 });
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

Native and WASM engines are optional dependencies. A usable native engine does not require WASM. When native selection is unavailable or incompatible, conversion requires an installed WASM package; otherwise `createConverter()` rejects with `unavailable`. Application builders choose and verify the engines they distribute.

Each converter serializes renders. A render creates a separate native process or Node worker and private profile, so fonts, document state, and failures do not leak into later renders. The deadline begins after acquiring its conversion slot. An `AbortSignal` cancels queued or active work; cancellation and `dispose()` await process or worker exit and scratch cleanup. Disposed converters reject further work.

Conversion workers run the package's shipped JavaScript with an empty `execArgv`; consumer launch flags such as `--input-type=module` are not inherited.

On Linux, the native child searches the selected engine's program directory before system paths for shared libraries. Caller-provided `LD_LIBRARY_PATH` and `LD_PRELOAD` are not inherited.

The caller authorizes input access and owns private input/output directories; paths must be absolute and remain unchanged during conversion. Input files must be regular OOXML files within the configured ZIP and byte limits. Output creation uses exclusive mode and permissions `0600`; an existing output is never overwritten. Failed or cancelled renders remove newly created outputs. `maxOutputBytes` limits the returned PDF and its read buffer; native temporary disk files can grow until export completes, then oversized PDFs are rejected and deleted before Node reads them. The caller owns successful PDFs and may send their bytes to a browser PDF viewer.

`ConversionError.code` distinguishes `invalid-document`, `unsupported-format`, `input-too-large`, `output-too-large`, `invalid-output`, `timeout`, `unavailable`, and `failed`. These codes survive the worker/native transports. Invalid installation assets reject creation as `unavailable`; they never enable fallback. Filesystem errors such as `EEXIST`, invalid configuration errors, and caller cancellation reasons remain unchanged.

## Engines, fonts, and runtime behavior

The Node API and engine packages share the kit release version. `ENGINE_VERSION` pins both WASM and native optional dependencies to the exact engine version. npm installs prepared engines; installation and conversion never compile LibreOffice or download additional engine payloads. Each engine includes its matching source recipes, patches, build information, and third-party license notices under `sources/` and `licenses/`.

Defaults and all options are documented in the shipped TypeScript declarations in `lib/types/index.d.ts`. Font directories use conventional system/user paths for the selected OS. Indexing skips missing or protected sources and propagates other filesystem errors. `fontkit` indexes original font files and selects installed faces and glyph coverage; it does not rewrite fonts. The converter reuses its first font metadata snapshot; recreate the converter after changing installed fonts. Original font bytes and decoded glyph coverage remain conversion-local. `missingFonts` contains absent families declared in readable document XML, excluding unrelated engine defaults. Missing glyphs without a named missing family are not a complete document accessibility report.

Exact installed families take priority in font matching, including explicitly requested handwriting or decorative fonts. Default `fontFallbacks` prefer common serif, sans-serif, and monospaced text families and corresponding Simplified Chinese faces, with Carlito for Calibri and Calibri Light, and Caladea for Cambria. Catalog matching retains the weight and italic style supplied by WASM font requests when matching faces are installed. The complete indexed catalog remains available for glyphs absent from the preferred families. Caller-provided groups replace the defaults; `[]` removes these preferences without disabling catalog discovery. WASM uses the same ordered aliases for imported fonts. The shipped option types describe `fontFallbacks`.

Native conversion writes missing-family choices into its private LibreOffice profile. LibreOffice resolves installed originals and its metric-compatible fonts before consulting these choices, so custom groups can produce different substitutions across engines. Native weight and italic selection depend on the engine and the fonts it can discover; native font preloading requests regular faces.

`maxFontFiles` and `maxFontFileBytes` bound font indexing; `maxLoadedFontBytes` bounds original files explicitly imported by this kit per conversion. WASM uses only imported originals and rejects with `unavailable` when no usable fonts are found; install fonts or configure `fontDirectories` before converting in a minimal container. Native macOS and Windows engines can also use OS-managed fonts, so the import limit is not a cap on native total font memory. Font matching and XML work run inside the cancellable worker; no browser font RPC or DOM is involved.

Node WASM image downscaling uses LibreOffice's CPU image filter. Text layout, font matching, and PDF serialization are CPU work as well.

For reproducible comparisons, use identical documents, fonts, DPI, and limits in separate installations with and without the optional native package. Report engine startup together with conversion time; every render starts a fresh engine. The WASM assets and platform payloads carry their source, license, and integrity manifests.

## Source and license

This package is licensed under [MPL-2.0](LICENSE). The engine packages include `prebuilds.json` integrity inventories, corresponding source recipes and patches in `sources/`, and third-party redistribution notices in `licenses/`.

## Limitations

- Fidelity depends on source formatting, installed fonts, and the selected engine. Missing-font names do not report every missing glyph.
- Only DOCX, XLSX, and PPTX input is supported. Conversion does not discover system LibreOffice or download engines and fonts.
- Font import and output limits do not bound all native memory or temporary disk use. Native platform engines may resolve fonts differently from WASM.
- Installations from npm use platform-specific optional packages. Applications that bundle engines must retain the complete selected package, including its resources and notices.
- Windows x64 requires the Microsoft Visual C++ v14 x64 Redistributable; it is not bundled.
- Version `0.0.1` ships macOS ARM64 and Windows x64 native engines and a shared Node WASM engine. Other native platforms are development recipes.
