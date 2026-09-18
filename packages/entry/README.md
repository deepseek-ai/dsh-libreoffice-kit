# @deepseek-ai/libreoffice-kit

The Node API, CLI, browser adapters and font service share this package. Its exact-version dependency, `@deepseek-ai/libreoffice-kit-wasm`, carries the prebuilt engine for all supported hosts. Installation and document operations never compile, download, or discover a system LibreOffice. Node.js 22.19 or newer is required.

```ts
import { createConverter, discoverRuntime } from '@deepseek-ai/libreoffice-kit'

const converter = await createConverter({ timeoutMs: 120_000 })
try {
  // Office paints directly from its model; PDF inputs use PDFium.
  const images = await converter.renderImages({
    inputPath: '/private/report.docx', outputDir: '/private/new-images', pages: [1, 3], dpi: 144,
  })
  await converter.convert({ inputPath: '/private/report.doc', outputPath: '/private/new-report.docx' })
  await converter.recalculate({ inputPath: '/private/book.xlsx', outputPath: '/private/recalculated.xlsx' })
} finally {
  await converter.dispose()
}
const runtime = await discoverRuntime() // installed CLI and API paths; no engine start
```

## Direct image rendering

`renderImages(request, signal?)` loads one saved input snapshot and produces `page-0001.png`, subsequent images, and `manifest.json` in a **new** directory. It supports DOC/DOCX/ODT, XLS/XLSX/ODS, PPT/PPTX/ODP, and PDF. Office rasterization never exports an intermediate PDF. The existing `render({inputPath,outputPath})` method still exports PDF for compatibility.

- Writer, Impress and PDF use distinct, one-based `pages`, preserving the requested order. Omit it or specify `'all'` for all physical pages/slides.
- Calc uses an exact `sheet` name and optional `range: 'A1:D20'`; a range requires a sheet. Without selectors, every visible sheet's data area is captured. `pages` is rejected for worksheets. Hidden/filtered rows and columns retain their display behavior. The default data area excludes formatting-only cells and standalone drawings; select an explicit range to include additional content. An empty sheet renders A1.
- `dpi` defaults to 144 and accepts 24–600. Each image is bounded by `maxPixels` (default and maximum 16,777,216) and `maxDimension` (default 8192 pixels per side). Large worksheet regions split on the output-pixel grid in row order. Each fragment retains the requested `sheet`/`range`; its `rectangle` identifies the exact source portion. Writer, Impress and PDF keep whole pages and reject an oversized page.
- `maxPages` defaults to 100 and limits the total output image count, including worksheet fragments across all selected sheets. The complete batch is checked before painting; limits reject the request instead of truncating it.
- `maxInputBytes`, aggregate PNG `maxOutputBytes`, font limits, and `timeoutMs` come from `ConverterOptions`. Defaults and all options are in the shipped TypeScript declarations.
- The manifest identifies `source: 'saved'`, the original `inputPath`, `sourceSha256`, `backend: 'wasm'`, `rasterEngine: 'libreoffice' | 'pdfium'`, total `pageCount`, selected images, dimensions, source rectangles at 96 DPI, and OOXML missing-font diagnostics. For Calc, `pageCount` is the visible sheet count and each image has `sheet`/`range` instead of `page`.

Absolute paths must be caller-authorized, private, and protected against concurrent path replacement. Input must be a nonempty regular file. The output directory must not exist. Cancellation, timeout, disposal or any failure waits for Worker exit and removes the whole newly owned output batch; it never removes a pre-existing output directory. Calls on one converter are serialized. Every operation starts a fresh Worker/model; retained browser editor sessions use the browser adapter.

## CLI and conversions

```sh
libreoffice-kit capabilities --json
libreoffice-kit render --input report.docx --output-dir new-images --pages 1,3 --dpi 144
libreoffice-kit render --input book.xlsx --output-dir new-sheet --sheet 'Summary' --range A1:D20
libreoffice-kit render --input document.pdf --output-dir new-pdf-images
libreoffice-kit convert --input report.docx --output report.pdf
libreoffice-kit convert --input book.xlsx --output table.csv --sheet 'Summary'
libreoffice-kit recalculate --input book.xlsx --output checked.xlsx
```

CLI paths resolve against its working directory. Success writes one JSON object to stdout; failure writes `{code,error}` to stderr and exits with status 1. SIGINT/SIGTERM cancel and await cleanup. `render` accepts `--max-pages`, `--max-pixels`, `--max-dimension`, and the common `--timeout-ms`, `--max-input-bytes`, `--max-output-bytes`, archive/font limits, repeated `--font-directory`/`--initial-font-family`, and JSON `--font-fallbacks`.

`convert` supports Writer → PDF/DOCX/ODT/TXT, Calc → PDF/XLSX/ODS/CSV, Impress → PDF/PPTX/ODP. CSV requires an exact sheet for multi-sheet inputs and emits UTF-8 with a comma delimiter. `recalculate` synchronously recalculates XLS/XLSX/ODS and saves XLSX/ODS with formulas and refreshed cached results; it does not validate business logic. Conversion outputs must be fresh exclusive files. Macros and external-link updates remain disabled.

## Fonts and PDF scope

Node operations use bounded system-font discovery. Exact installed families precede configured fallbacks; default Korean sans/serif preferences select body-text fonts before handwriting even when the document language is absent. Unlisted fallback faces classified by OS/2 as script or decorative rank below other text faces, but remain available for otherwise missing glyphs. Full original font files retain shaping and encoding. Recreate the converter after changing installed fonts. `missingFonts` covers named families in readable OOXML metadata, not all missing glyphs or PDF font diagnostics.

`createFontSource` from `@deepseek-ai/libreoffice-kit/fonts` provides an independent lazy Worker service. `resolve(attributes)` retains the Unicode-script subset behavior for interactive Office. `resolve({...attributes, mode:'full'})` returns opaque `full_…` identities, original family names and `format` (`ttf`, `otf`, `ttc`); `read(id)` returns complete original font bytes. Apple dfont resources are extracted as complete sfnt faces. Reads reject unknown or changed sources and do not expose host paths.

PDFium is an experimental direct raster path, separate from PDF.js and editable Office models. Embedded PDF fonts remain PDFium-owned. A fixed, bounded set of regular faces selected from `initialFontFamilies` and fallback groups is mounted before PDFium's first font enumeration. This does not infer every arbitrary PDF font or repair custom encodings. Password-protected PDFs are rejected; forms are rasterized by the upstream PDFium wrapper, while ordinary annotations and advanced PDF features require further qualification.

## Browser and font entries

`@deepseek-ai/libreoffice-kit/browser` provides persistent Office editing, read-only legacy Office models, PDFium viewing and consistent image capture. `@deepseek-ai/libreoffice-kit/browser-assets` resolves the local browser Worker and validates the assets in the exact-version WASM dependency. Host asset servers expose these resources as opaque URLs; the main package does not duplicate the LibreOffice payload.

`./fonts` provides the Host font service described above. Browser-safe `./font-config` and `./document-inspection` share font configuration and input validation with the Node API. `./internal/*` exports are implementation details used by the bundled browser Worker.

Subsets use Unicode 17 script data and HarfBuzz layout/composite closure. Their bounded in-memory cache can regenerate evicted entries from unchanged originals. [The subset build recipe](../../engine/font-subset/README.md) pins source and redistribution notices.

## Source and license

This package is licensed under [MPL-2.0](LICENSE). Engine `prebuilds.json` inventories, corresponding pinned source recipes and patches in `sources/`, and third-party notices in `licenses/` accompany the engine payload. The font subsetter carries its own pinned recipe and redistribution notices. Applications bundling the engine must retain these resources and notices. Declared targets and source-level tests do not substitute for testing the installed engine on representative files.
