# LibreOffice Kit

Convert private disk DOCX, XLSX, and PPTX files to PDF in Node.js 22.19 or later. The entry package selects its installed OS/architecture/libc package and runs the native LibreOfficeKit helper. An absent platform package selects the required Node WebAssembly package. Installed packages with missing assets, incompatible manifests, or failing engines reject the conversion. Runtime downloads and compilation are not used.

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

The caller authorizes input access and owns private input/output directories; paths must be absolute and remain unchanged during conversion. Input files must be regular OOXML files within the configured ZIP and byte limits. Output creation uses exclusive mode and permissions `0600`; an existing output is never overwritten. Failed or cancelled renders remove newly created outputs. The caller owns successful PDFs and may send their bytes to a browser PDF viewer.

Defaults and all options are documented in [the TypeScript API](src/index.d.ts). Font directories default to conventional system/user locations. `fontkit` indexes original font files and selects installed faces and glyph coverage; it does not rewrite fonts. The converter reuses its first font metadata snapshot; recreate the converter after changing installed fonts. Original font bytes and decoded glyph coverage remain conversion-local. Exact family matches precede `fontFallbacks`. `missingFonts` contains absent families declared in readable document XML, excluding unrelated engine defaults. Missing glyphs without a named missing family are not a complete document accessibility report.

`maxFontFiles` and `maxFontFileBytes` bound font indexing; `maxLoadedFontBytes` bounds original files explicitly imported by this kit per conversion. WASM uses only imported originals. Native macOS and Windows engines can also use OS-managed fonts, so the import limit is not a cap on native total font memory. Font matching and XML work run inside the cancellable worker; no browser font RPC or DOM is involved.

Node WASM image downscaling optionally uses the device's WebGPU adapter through `webgpu`. `gpu: 'off'` selects LibreOffice's CPU filter; `'auto'` also uses that filter when a device or an operation is unavailable. GPU initialization and operations have separate limits, and unsuccessful GPU work cannot overwrite WASM output. `imageScaling` reports the adapter choice and actual image callback counters for performance comparisons. Native rendering uses LibreOffice's own platform graphics implementation; these callback counters are zero. Text layout, font matching, and PDF serialization remain CPU work.

For reproducible comparisons, use identical documents, fonts, DPI, and limits in separate installations with and without the optional native package. Report engine startup together with conversion time; every render starts a fresh engine. The required WASM assets and platform payloads carry their source, license, and integrity manifests.
