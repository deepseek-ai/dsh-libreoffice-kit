# LibreOffice browser renderer and editor

`@deepseek-ai/libreoffice-kit/browser` loads original Office bytes in a dedicated Worker and draws Writer pages or normal Impress slides through LibreOfficeKit tile APIs. It does not export or parse a PDF. All page coordinates are CSS pixels at 96 DPI; `scale` controls output pixel density. Returned pixels are owned, unassociated RGBA bytes for `ImageData`.

Serve the five resources declared in `assets.json` with their original bytes and expose their URLs through `BrowserEngineAssets`. The package has no operating-system restriction. The application must provide a secure, cross-origin-isolated context (`COOP: same-origin`, `COEP: credentialless`) and a Content Security Policy permitting its engine Worker, nested pthread Workers and WebAssembly. The loader starts its pthreads from the same loader URL; the worker bundle has no external JavaScript imports.

`openDocument({ extension: 'pdf', ... }, signal)` opens a standalone PDF with PDFium in a dedicated Worker. Its fixed pages and serialized tiles are read-only. PDFium preloads the configured original fonts; the Host request explicitly uses `mode: 'full'`. Embedded fonts take priority. The browser owns viewport, cache and PNG assembly.

Office uses a retained `openEditor` model for both viewing and editing. DOC/XLS/PPT require `readOnly: true`; DOCX/XLSX/PPTX can also use this mode for read-only image inspection. Office font requests use reusable subsets and canonical family names; explicit full-font PDF requests preserve original TTF/OTF/TTC bytes. No production fonts are bundled. Disposal joins the owning Worker and pthreads; hiding an Office tab should retain its model.

`openEditor(options, signal)` opens DOCX, XLSX and PPTX with the same resource and font inputs. It retains an editable LibreOffice model, accepts keyboard, mouse, IME and UNO commands, publishes state and invalidated rectangles, and exports OOXML snapshots. Edits redraw tiles directly without a PDF intermediate. The [editing API](../../docs/browser-editing.md) defines geometry, ordered input, snapshot saves and application ownership; the editor does not supply a toolbar, file persistence or collaborative editing.

Build with `node scripts/build-browser.mjs --stage` after staging the verified WASM engine. The main package owns the browser bundles; `resolveBrowserAssets()` from `@deepseek-ai/libreoffice-kit/browser-assets` resolves and verifies the assets split across the main and WASM packages. The engine bytes are not duplicated in this private source workspace's npm output.

The Host font API is `@deepseek-ai/libreoffice-kit/fonts`. Both APIs ship in the existing main package. The [preview candidate](../../docs/building.md) packs only main and WASM, plus a separate offline third-party dependency closure for qualification.

Run `node scripts/smoke-browser-editor.mjs --candidate <packed-browser-directory> --native <soffice> --output <receipt.json>` for editing qualification. It installs the archived packages outside the checkout with an offline npm registry, edits all three OOXML formats, saves and reopens them through both WASM and native LibreOffice, observes new-character font loading, and awaits Worker exit. Its small fixtures and warm-input timings do not establish arbitrary-document fidelity or a universal latency bound.

The Worker bundles fflate, saxes and xmlchars; their notices are included under `licenses/javascript/`. The saxes 6.0.0 npm archive omits its license, so `third-party/saxes-6.0.0-LICENSE` preserves the [upstream versioned license](https://github.com/lddubeau/saxes/blob/v6.0.0/LICENSE).
