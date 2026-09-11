# LibreOffice Kit

Convert private disk DOCX, XLSX, and PPTX files to PDF in Node.js 22.19 or later. The entry package selects its installed OS/architecture/libc package and runs the native LibreOfficeKit helper. An absent platform package or a known host glibc version below its recorded `engine.glibcMinimum` selects the required shared Node WebAssembly package. Installed packages with missing assets, incompatible manifests, or failing engines reject the conversion. Runtime downloads and compilation are not used.

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

Each converter serializes renders. A render creates a separate native process or Node worker and private profile, so fonts, document state, and failures do not leak into later renders. The deadline begins after acquiring its conversion slot. An `AbortSignal` cancels queued or active work; cancellation and `dispose()` await process or worker exit and scratch cleanup. Disposed converters reject further work.

Conversion and GPU workers run the package's shipped JavaScript with an empty `execArgv`; consumer launch flags such as `--input-type=module` are not inherited.

On Linux, the native child searches the selected engine's program directory before system paths for shared libraries. Caller-provided `LD_LIBRARY_PATH` and `LD_PRELOAD` are not inherited.

The caller authorizes input access and owns private input/output directories; paths must be absolute and remain unchanged during conversion. Input files must be regular OOXML files within the configured ZIP and byte limits. Output creation uses exclusive mode and permissions `0600`; an existing output is never overwritten. Failed or cancelled renders remove newly created outputs. `maxOutputBytes` limits the returned PDF and its read buffer; native temporary disk files can grow until export completes, then oversized PDFs are rejected and deleted before Node reads them. The caller owns successful PDFs and may send their bytes to a browser PDF viewer.

`ConversionError.code` distinguishes `invalid-document`, `unsupported-format`, `input-too-large`, `output-too-large`, `invalid-output`, `timeout`, `unavailable`, and `failed`. These codes survive the worker/native transports. Invalid installation assets reject creation as `unavailable`; they never enable fallback. Filesystem errors such as `EEXIST`, invalid configuration errors, and caller cancellation reasons remain unchanged.

Defaults and all options are documented in [the TypeScript API](src/index.d.ts). Font directories default to conventional system/user locations. `fontkit` indexes original font files and selects installed faces and glyph coverage; it does not rewrite fonts. The converter reuses its first font metadata snapshot; recreate the converter after changing installed fonts. Original font bytes and decoded glyph coverage remain conversion-local. Exact family matches precede `fontFallbacks`. `missingFonts` contains absent families declared in readable document XML, excluding unrelated engine defaults. Missing glyphs without a named missing family are not a complete document accessibility report.

`maxFontFiles` and `maxFontFileBytes` bound font indexing; `maxLoadedFontBytes` bounds original files explicitly imported by this kit per conversion. WASM uses only imported originals and rejects with `unavailable` when no usable fonts are found; install fonts or configure `fontDirectories` before converting in a minimal container. Native macOS and Windows engines can also use OS-managed fonts, so the import limit is not a cap on native total font memory. Font matching and XML work run inside the cancellable worker; no browser font RPC or DOM is involved.

Node WASM image downscaling can use a device GPU. `gpu: 'auto'` tries WebGPU, WebGL2, WebGL1, then LibreOffice's CPU filter; `'off'` selects CPU directly. Explicit `'webgpu'`, `'webgl2'`, or `'webgl1'` choices try only that provider and report CPU with a reason when it is unavailable. Each initialization attempt has its own deadline, and failed workers exit before the next provider starts. GPU operations have a separate deadline, and unsuccessful work cannot overwrite WASM output. `imageScaling` reports the adapter choice and actual image callback counters for performance comparisons. Native rendering uses LibreOffice's own platform graphics implementation; these callback counters are zero. Text layout, font matching, and PDF serialization remain CPU work.

For reproducible comparisons, use identical documents, fonts, DPI, and limits in separate installations with and without the optional native package. Report engine startup together with conversion time; every render starts a fresh engine. The required WASM assets and platform payloads carry their source, license, and integrity manifests.
