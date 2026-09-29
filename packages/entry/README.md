# @deepseek-ai/libreoffice-kit

English | [中文](README.zh.md)

Convert, recalculate, and directly render local Office documents with prebuilt LibreOffice engines. Use the same API in a server, desktop application, or document-processing job, with configurable fonts, cancellation, and resource limits.

Binary `.doc`, `.xls`, and `.ppt` inputs must be OLE compound documents, such as Office 97–2003 files. Renamed RTF/HTML and `.wps` inputs are unsupported. `missingFonts` is empty for binary inputs because their font tables are interpreted by LibreOffice rather than the OOXML inspector.

The Node API version is independent of its platform engine versions. Version 0.1.3 uses macOS and Windows engines 0.1.3 and retains WASM engine 0.1.1. `ENGINE_VERSION` and `discoverRuntime().version` identify the Node API; `ENGINE_VERSIONS` lists the exact compatible engine versions.

## Installation and usage

Install with Node.js 22.19.0 or newer:

```sh
npm install @deepseek-ai/libreoffice-kit@0.1.3
```

npm installs the matching native engine on macOS/Windows ARM64 or x64, and the shared WASM engine on Linux. macOS and Windows require their native package; a missing or invalid package rejects `createConverter` with `unavailable`, without switching to WASM. Linux uses WASM unless a compatible development native package was installed explicitly. Conversion failures never switch engines.

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

Native and WASM engines are platform-filtered optional dependencies. Application builders must verify the required engine is installed: native on macOS/Windows, WASM on Linux. A missing required engine rejects `createConverter()` with `unavailable`.

Each converter serializes renders. A render creates a separate native process or Node worker and private profile, so fonts, document state, and failures do not leak into later renders. The deadline begins after acquiring its conversion slot. An `AbortSignal` cancels queued or active work; cancellation and `dispose()` await process or worker exit and scratch cleanup. Disposed converters reject further work.

Converters created through the compatibility `createConverter(options)` API transparently share bounded font metadata and match results with other process-local converters using the same engine and font configuration. Disposing a converter still joins only its own work; metadata remains available to later compatible converters, with at most 16 retained configurations. `maxFontMetadataCacheBytes` bounds retained per-file metadata; `maxFontResolutionEntries` bounds matching entries and defaults to 4096.

For a long-lived service that wants one explicit lifecycle owner for concurrent conversion slots, create one `createConverterFactory(options)` and obtain converters through `factory.create()`. Those converters use a factory-private cache while retaining separate Workers, native helpers, profiles, and output ownership. Dispose the factory to stop and join every converter it created.

`convert()` exports the format named by the output suffix, `recalculate()` refreshes spreadsheet formula results before saving, and `renderImages()` writes a fresh directory containing PNG tiles plus `manifest.json`. Office images are painted directly from one loaded model; PDF images use PDFium. The CLI exposes the same operations through `dsoffice capabilities|convert|recalculate|render`.

```sh
npm exec -- dsoffice render --input report.docx --output-dir report-pages --pages 1
npm exec -- dsoffice render --input budget.xlsx --output-dir budget-preview --sheet Summary --range A1:D20
npm exec -- dsoffice convert --input report.docx --output report.pdf
npm exec -- dsoffice recalculate --input budget.xlsx --output recalculated.xlsx
```

Conversion workers run the package's shipped JavaScript with an empty `execArgv`; consumer launch flags such as `--input-type=module` are not inherited.

On Windows, an engine executable or program path of 260 or more characters uses a temporary helper copy and a junction to the installed resources inside the private operation directory. Resources stay in their installation, and the junction remains until the helper closes. A renderer that exits before returning a protocol response rejects with its exit status and captured diagnostics.

On Linux, the native child searches the selected engine's program directory before system paths for shared libraries. Caller-provided `LD_LIBRARY_PATH` and `LD_PRELOAD` are not inherited.

The caller authorizes input access and owns private input/output directories; paths must be absolute and remain unchanged during conversion. Input files must be regular Office files within the configured byte limits. ZIP entry and uncompressed-size limits apply to OOXML; binary DOC/XLS/PPT files use OLE compound containers validated by the LibreOffice importer. Binary formats retain the same conversion deadline and input/output limits. Output creation uses exclusive mode and permissions `0600`; an existing output is never overwritten. Failed or cancelled renders remove newly created outputs. `maxOutputBytes` limits the returned PDF and its read buffer; native temporary disk files can grow until export completes, then oversized PDFs are rejected and deleted before Node reads them. The caller owns successful PDFs and may send their bytes to a browser PDF viewer.

`ConversionError.code` distinguishes `invalid-document`, `unsupported-format`, `input-too-large`, `output-too-large`, `invalid-output`, `timeout`, `unavailable`, and `failed`. These codes survive the worker/native transports. Invalid installation assets reject creation as `unavailable`; they never enable fallback. Filesystem errors such as `EEXIST`, invalid configuration errors, and caller cancellation reasons remain unchanged.

## Engines, fonts, and runtime behavior

The Node API reports its release version through `ENGINE_VERSION`; `ENGINE_VERSIONS` pins each platform engine independently. npm installs prepared engines; installation and conversion never compile LibreOffice or download additional engine payloads. Each engine includes its matching source recipes, patches, build information, and third-party license notices under `sources/` and `licenses/`.

Defaults and all options are documented in the shipped TypeScript declarations in `lib/types/index.d.ts`. Font directories use conventional system/user paths for the selected OS. Indexing skips missing or protected sources and propagates other filesystem errors. `fontkit` indexes original font files and selects installed faces and glyph coverage; it does not rewrite fonts. Each operation discovers font candidates again and revalidates cached file identities. It uses one ordered metadata snapshot; matching entries are invalidated when that snapshot changes. A detected font change during conversion rejects the operation and removes its output. Original font bytes and decoded glyph coverage remain conversion-local. `missingFonts` contains absent families declared in readable document XML, excluding unrelated engine defaults. Missing glyphs without a named missing family are not a complete document accessibility report.

### Font metadata cache

Both `createConverter()` and `createConverterFactory()` accept:

| Option | Default | Behavior |
| --- | --- | --- |
| `fontMetadataCacheDirectory` | User system cache directory | Absolute directory path, or `false` to disable disk caching. |
| `maxFontMetadataCacheBytes` | 32 MiB | Positive safe integer limiting each cache file read/write and retained per-file metadata per shared configuration. |

The default directory is `~/Library/Caches/libreoffice-kit` on macOS, `%LOCALAPPDATA%/libreoffice-kit/Cache` on Windows (falling back to the user's `AppData/Local`), and `$XDG_CACHE_HOME/libreoffice-kit` on Linux (falling back to `~/.cache`). The single `font-metadata.json` file contains canonical file paths, exact decimal device/inode identifiers, size, modification/change times, and all face metadata, including empty parse results. It contains no font bytes, glyph coverage, parsed font objects, document text, or document matching entries. Keep this user-local file private.

A first run without reusable metadata performs the full original font inspection. Later processes skip inspection only for discovered files with matching identities. Each operation re-enumerates sources, including supplemental Office sources, so additions, deletions, replacements, and directory changes do not require a restart. Candidate order, file budgets, Office filtering, fallback matching, glyph queries, and original font import remain unchanged. A corrupted, incompatible, oversized, or inaccessible cache falls back to source inspection; unreadable source files never reuse stale records. Format, extractor, and pinned fontkit versions must match.

New cache directories and files use private permissions (`0700`/`0600` where supported). Writes close an exclusive temporary file in the same directory before atomic replacement. Unchanged snapshots are not rewritten; snapshots exceeding the byte limit are not retained or written. Independent processes may publish competing complete snapshots, affecting hit rate only. The owning operation cleans up its temporary file after its metadata Worker exits.

Simultaneous operations within one shared configuration share a short-lived metadata Worker. Each waiter keeps its own cancellation and deadline; cancelling one does not cancel the others. The last departing waiter terminates and joins the Worker. Completed scans retain bounded metadata, without a live scan Worker or original font buffers. Setting `fontMetadataCacheDirectory: false` keeps these in-process sharing and source-version checks. Factory caches have their own lifetime and are cleared by `factory.dispose()`.

When `fontDirectories` is omitted on macOS or Windows, default discovery also checks Microsoft Office's bundled/private font directory and the user's Office font cache. Only curated Office-compatible families absent from normal system roots are added, including SimSun and Microsoft YaHei. Explicit `fontDirectories` disables this supplemental discovery.

Exact installed families take priority in font matching, including explicitly requested handwriting or decorative fonts. Default `fontFallbacks` prefer common serif, sans-serif, and monospaced text families and corresponding Simplified Chinese faces, with Carlito for Calibri and Calibri Light, and Caladea for Cambria. Catalog matching retains the weight and italic style supplied by WASM font requests when matching faces are installed. The complete indexed catalog remains available for glyphs absent from the preferred families. Caller-provided groups replace the defaults; `[]` removes these preferences without disabling catalog discovery. WASM uses the same ordered aliases for imported fonts. The shipped option types describe `fontFallbacks`.

Native conversion writes missing-family choices into its private LibreOffice profile. LibreOffice resolves installed originals and its metric-compatible fonts before consulting these choices, so custom groups can produce different substitutions across engines. Native weight and italic selection depend on the engine and the fonts it can discover; native font preloading requests regular faces.

`maxFontFiles` and `maxFontFileBytes` bound font indexing; `maxLoadedFontBytes` bounds original files explicitly imported by this kit per conversion. WASM uses only imported originals and rejects with `unavailable` when no usable fonts are found; install fonts or configure `fontDirectories` before converting in a minimal container. Native macOS and Windows engines can also use OS-managed fonts, so the import limit is not a cap on native total font memory. Font matching and XML work run inside the cancellable worker; no browser font RPC or DOM is involved.

Node WASM image downscaling uses LibreOffice's CPU image filter. Text layout, font matching, and PDF serialization are CPU work as well.

For reproducible comparisons, use identical documents, fonts, DPI, and limits; WASM installations run on Linux. Report engine startup together with conversion time; every render starts a fresh engine. The WASM assets and platform payloads carry their source, license, and integrity manifests.

## Source and license

This package is licensed under [MPL-2.0](LICENSE). The engine packages include `prebuilds.json` integrity inventories, corresponding source recipes and patches in `sources/`, and third-party redistribution notices in `licenses/`.

## Limitations

- Fidelity depends on source formatting, installed fonts, and the selected engine. Missing-font names do not report every missing glyph.
- DOC/DOCX/ODT, XLS/XLSX/ODS, and PPT/PPTX/ODP conversion is supported; direct image rendering additionally accepts PDF. Conversion does not discover system LibreOffice or download engines and fonts.
- Font import and output limits do not bound all native memory or temporary disk use. Native platform engines may resolve fonts differently from WASM.
- Installations from npm use platform-specific optional packages. Applications that bundle engines must retain the complete selected package, including its resources and notices.
- Windows requires the Microsoft Visual C++ v14 Redistributable matching the Node.js architecture (x64 or ARM64); it is not bundled. Use ARM64 Node.js for the Windows ARM64 engine.
- Version `0.1.0` ships macOS and Windows native engines for ARM64 and x64 and a shared Node WASM engine for Linux. Other native platforms are development recipes.
