---
description: "Convert private DOCX, XLSX, and PPTX files to PDF with precompiled LibreOffice engines."
kind: "package-library"
---
# @deepseek-ai/libreoffice-kit

English | [中文](README.zh.md)

## Summary

Convert authorized disk DOCX, XLSX, and PPTX documents to PDF in Node.js. Node applications use this library for engine selection, cancellation, resource limits, and font loading. It selects an installed native engine or an installed shared WASM engine without compiling LibreOffice or downloading assets at runtime. Callers own source authorization and successful output files.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The internal preview bundles macOS ARM64 and shared WASM engines. This is a library dependency. The the host application composes it into Office preview. `createConverter` selects an installed OS/architecture/libc engine; an absent matching native package or a known host glibc below its recorded minimum selects WASM. Invalid installed assets and failed conversions reject.

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

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This repository publishes the Node API and engines in the same internal Release. `ENGINE_VERSION` pins the matching `@deepseek-ai/libreoffice-kit-*` engine version. Both WASM and native optional dependencies use `workspace:*`; packing records exact engine versions. Application builds authenticate downloads, override those versions with verified local installation tarballs, and bundle prepared engines; engines are not published to the npm registry. The [engine workspace](../../README.md) owns recipes, validation, and publication.

Defaults and all options are documented in [the TypeScript API](src/index.ts). Font directories use conventional system/user paths for the selected OS. Indexing skips missing or protected sources and propagates other filesystem errors. `fontkit` indexes original font files and selects installed faces and glyph coverage; it does not rewrite fonts. The converter reuses its first font metadata snapshot; recreate the converter after changing installed fonts. Original font bytes and decoded glyph coverage remain conversion-local. `missingFonts` contains absent families declared in readable document XML, excluding unrelated engine defaults. Missing glyphs without a named missing family are not a complete document accessibility report.

Exact installed families take priority in font matching, including explicitly requested handwriting or decorative fonts. Default `fontFallbacks` prefer common serif, sans-serif, and monospaced text families and corresponding Simplified Chinese faces, with Carlito for Calibri and Calibri Light, and Caladea for Cambria. Catalog matching retains the weight and italic style supplied by WASM font requests when matching faces are installed. The complete indexed catalog remains available for glyphs absent from the preferred families. Caller-provided groups replace the defaults; `[]` removes these preferences without disabling catalog discovery. WASM uses the same ordered aliases for imported fonts. The default groups are defined in [`src/options.ts`](src/options.ts).

Native conversion writes missing-family choices into its private LibreOffice profile. LibreOffice resolves installed originals and its metric-compatible fonts before consulting these choices, so custom groups can produce different substitutions across engines. Native weight and italic selection depend on the engine and the fonts it can discover; native font preloading requests regular faces.

`maxFontFiles` and `maxFontFileBytes` bound font indexing; `maxLoadedFontBytes` bounds original files explicitly imported by this kit per conversion. WASM uses only imported originals and rejects with `unavailable` when no usable fonts are found; install fonts or configure `fontDirectories` before converting in a minimal container. Native macOS and Windows engines can also use OS-managed fonts, so the import limit is not a cap on native total font memory. Font matching and XML work run inside the cancellable worker; no browser font RPC or DOM is involved.

Node WASM image downscaling uses LibreOffice's CPU image filter. Text layout, font matching, and PDF serialization are CPU work as well.

For reproducible comparisons, use identical documents, fonts, DPI, and limits in separate installations with and without the optional native package. Report engine startup together with conversion time; every render starts a fresh engine. The WASM assets and platform payloads carry their source, license, and integrity manifests.

No runtime invariant companion is published because each conversion owns its process or Worker and files, with no separately observed service state to reconcile.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The [packaging guide](../../docs/packaging.md) defines receipts and redistribution notices; the [release guide](../../docs/building.md) defines source tags and installed qualification.

-----

<a id="model-experience"></a>
## Model Experience

None, as disk conversion contributes no model input.

#### KV Cache effect

This library adds no tokens to model requests and changes no reusable model prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Fidelity depends on source formatting, installed fonts, and the selected engine. Missing-font names do not report every missing glyph.
- Only DOCX, XLSX, and PPTX input is supported. Conversion does not discover system LibreOffice or download engines and fonts.
- Font import and output limits do not bound all native memory or temporary disk use. Native platform engines may resolve fonts differently from WASM.
- npm downloads URL optional dependencies before applying platform filters, so installation may download native archives it does not retain. Conversion itself stays offline.
- Native Windows build recipes do not imply qualified releases; the adapter manifest declares the released native targets.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
