# LibreOffice browser reading sessions

`@deepseek-ai/libreoffice-kit/browser` loads original Office bytes in a dedicated Worker and paints directly through LibreOfficeKit. Office tiles never pass through PDF. Coordinates use CSS pixels at 96 DPI; `scale` controls pixel density. Returned unassociated RGBA bytes are owned by the caller and can be used with `ImageData`.

## Office documents

`openOfficeDocument(options, signal)` opens DOC/DOCX, XLS/XLSX or PPT/PPTX once and retains a **read-only** document model. The API exposes state subscriptions, tiles, viewport updates, primary-pointer selection, navigation keys, Select All, plain-text copying, worksheet/slide selection and bounded A1 navigation. Impress copies the complete text of selected text objects or groups; it does not enter text editing or select substrings inside objects. Hiding a tab should retain its model; disposing it joins its Worker and pthreads.

There is no editable mode, `openEditor`, raw key/text/IME input, arbitrary UNO command, paste, cut, snapshot save or browser capture API. The Worker validates the same restricted operations and loads the native document and its LOK views as read-only. Internal virtual-file-system writes are still required to load source bytes and fonts. The browser API has no host file-write service; the separate Node/CLI conversion and recalculation APIs retain their explicit output operations.

```ts
const document = await openOfficeDocument({ ...resourcesAndFonts, data, extension: 'docx' })
const unsubscribe = document.subscribe(event => {
  if (event.type === 'invalidate') invalidateTiles(event.part, event.rectangle)
})
await document.setLayout({ mode: 'continuous', width: contentWidth / zoom })
await document.setViewport({ x: 0, y: 0, width: 600, height: 800 }, devicePixelRatio * zoom)
// Supply current-part rectangles from document.state and cache their pixels.
const tile = await document.renderTile({ part: 0, x: 0, y: 0, width: 256, height: 256, scale: devicePixelRatio * zoom })
unsubscribe()
await document.dispose()
```

Writer starts in `paginated` layout. `setLayout({mode: 'continuous', width, anchor?})` reflows body text to the supplied content width; caller padding is outside this width. An optional point in the previous layout resolves to a body-text rectangle in the new layout. When no body anchor is returned, applications may restore normalized reading progress. The returned geometry includes one continuous rectangle, without synthetic page gaps. Wide fixed tables or drawings can extend beyond the requested width.

`setViewport` changes scrolling and raster zoom only. Equal layout widths are deduplicated and pending layout requests coalesce to the latest width. DPR changes must update pixel density without changing the document width. `layoutGeneration` changes when layout changes; `renderGeneration` changes for invalidated geometry or pixels, including newly resolved fonts. Cache entries and in-flight results must be checked against the invalidation state. Impress paints inactive slides through a separate read-only capture view and restores the reading view after native event processing. Calc rejects stale inactive-sheet tiles before painting, preserving its active selection.

`renderTile` paints the current part for Writer and Calc; Impress can also paint inactive slides through its capture view. A tile queued before `setPart` may become obsolete: the Worker rejects it with `BrowserRenderError.code === 'stale-part'` before entering LibreOffice painting, without changing selection or closing the session. Discard that expired display request. Already-started valid painting may still finish and enter the cache. Background multi-sheet image export belongs to the separate Node/CLI API.

## PDF, resources and fonts

`openDocument({ extension: 'pdf', ... }, signal)` retains the existing PDFium browser API. Its fixed pages and serialized tiles are read-only. PDFium preloads the configured original fonts with explicit `mode: 'full'`; embedded fonts take priority. Applications own viewport, cache and PNG assembly.

Serve the resources declared in `assets.json` unchanged through `BrowserEngineAssets`. A secure cross-origin-isolated context is required (`COOP: same-origin`, `COEP: credentialless`), with a Content Security Policy permitting the engine Worker, nested pthread Workers and WebAssembly. The loader starts pthreads from the same loader URL; the Worker bundle has no external JavaScript imports.

`prepareOfficeBrowser(assets, signal?)` compiles the WASM resource without creating a Worker or `WebAssembly.Memory`. Pass its opaque result as `preparedEngine` when opening documents. The handle is structured-cloned into each document Worker and must match the supplied WASM URL; omitting it retains on-demand compilation.

`@deepseek-ai/libreoffice-kit/fonts` provides the shared Host font service. Office requests reusable subsets with canonical family names; PDFium requests original TTF/OTF/TTC bytes. The platform/script fallback rules and optional uncovered-code-point diagnostics are shared by Node, CLI and browser. Production fonts are not bundled. The main package owns `./browser`, `./browser-assets` and `./fonts`; the existing `-wasm` dependency owns the engine resources. No extra npm package is required.

Office starts its initial fallback-font request before loading engine assets so Host font discovery can overlap engine startup. For OOXML subset requests, the first request for one font-attribute and Unicode-script group covers that script's document repertoire; later calls use the installed coverage. The response uses the same bounded, cancellable channel as later requests.

The browser font channel transfers each immutable font asset once per document. `resolveFonts(request, known, signal)` receives the installed identities and may return metadata-only references for them; new assets carry bytes. Later resolutions therefore avoid both Host downloads and Worker transfer, including multiple family aliases in one TTC. Installation failures and incomplete transfers do not create reusable identities.

## Building and qualification

Build with `node scripts/build-browser.mjs --stage` after staging the version-matched WASM engine. `resolveBrowserAssets()` from `@deepseek-ai/libreoffice-kit/browser-assets` resolves and verifies resources from the two installed packages. Candidate verification caps the main archive at 512 KiB and the WASM archive at 60 MiB. Qualification must install archived packages outside the checkout and cover three-format reading, selection/copy, refusal of editing operations, Writer layouts, source-byte preservation and Worker disposal. Unit fixtures do not establish real-document fidelity or input latency.

The Worker bundles fflate, saxes and xmlchars; notices are included under `licenses/javascript/`. The saxes 6.0.0 archive omits its license, so `third-party/saxes-6.0.0-LICENSE` preserves the [upstream versioned license](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE).
