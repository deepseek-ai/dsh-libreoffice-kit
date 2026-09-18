# Packaging

Source package manifests name the source repository. During GitHub Actions packing, `GITHUB_REPOSITORY` and the HTTPS origin `GITHUB_SERVER_URL` identify the repository that builds the release. The packer changes only disposable staging manifests; source manifests and executable payload modes remain unchanged. Local packing without workflow identity retains the source metadata. Invalid or missing workflow identity fails before any tarball is written.

The engine family shares the version declared in the root package manifest and distributes `@deepseek-ai/libreoffice-kit-*` tarballs through the internal `deepseek-harness/libreoffice-kit` Releases. The Node API [`@deepseek-ai/libreoffice-kit`](../packages/entry/README.md) shares that version and pins engines through `ENGINE_VERSION`. Its optional WASM and macOS/Windows ARM64/x64 dependencies use `workspace:*`; pnpm packing records exact engine versions. Application builders prepare authenticated downloads through the [release workflow](building.md), override these versions with verified local installation tarballs, and bundle the engines. For public npm publication, `release:prepare-npm` derives audited standard npm archives from the same qualified candidate; see [public preparation](building.md). Runtime conversion performs no download or compilation and needs no GitHub credential. All packages require Node.js >=22.19.

The Linux candidate declares only WASM and publishes exactly `@deepseek-ai/libreoffice-kit` and `@deepseek-ai/libreoffice-kit-wasm`. Native build recipes remain development tooling. macOS/Windows preparation rejects this candidate; their WASM migration requires separate runtime and installed-engine qualification. Adding a native release target requires an adapter optional dependency, build workflow wiring, and matching-host qualification.

Development archives may contain a subset of engine tarballs. Offline verification installs the candidate's staged Node API tarball; a rehearsal without one packs the adapter that `pnpm run build:adapter` already produced and fails when that build is missing. By default it installs only the host engine: native on macOS/Windows, WASM on Linux. Explicit Linux development rehearsals may install both engines. Pack the Node API with `pnpm run build:adapter --pack <candidate>` after packing engines. Publication includes that exact tarball and binds it to every host receipt.

There is exactly one WASM package per version, with npm `os: ["linux"]` and no `cpu` or `libc` restrictions. Hosts that install WASM receive identical loader, `.wasm`, and resource-data bytes. The complete preview release contains one shared WASM tarball and four native tarballs for macOS and Windows on ARM64 and x64. Verification on multiple hosts installs that same candidate without rebuilding it.

Public candidates preserve matching source recipes, patches and license notices. The build recipe records the organization vendor and normalized build paths; publication gates scan the final archive contents before any upload. A privacy failure requires a new candidate and fresh qualification when its contents change.

## Download and installation archives

Engine Release assets use `.tar.xz`. Each XZ-compressed outer tar contains exactly one regular file, `package.tar`: the unchanged npm package tar before gzip compression. The release record stores `file`, `bytes`, and `sha256` for the transfer, plus `install: { file, bytes, sha256 }` for that inner tar. The install filename is the transfer filename without `.xz`. The Node API and OS-independent browser API remain conventional `.tgz` archives.

Preparation requires system `tar` with XZ support. It verifies the transfer size and SHA-256, rejects any envelope containing additional members, streams `package.tar` into a private file, and verifies its independent size and SHA-256 before installation. npm and pnpm install the prepared plain `.tar`; a frozen lockfile therefore does not depend on the host's gzip encoder. Application distribution may gzip that verified tar during its build and record the resulting archive hash. Runtime conversion has no XZ decoder or archive preparation step. Download bytes, installation tar bytes, and unpacked file bytes are different measurements.

WASM packaging removes named desktop resources from `soffice.data`, preserving every retained byte and metadata attribute while rebuilding offsets and total size. The loader and compiled module remain unchanged. Original compilation hashes and the packaging recipe are both recorded; [the WASM recipe](../engine/wasm-source/README.md) defines when compilation is required.

## Browser rendering, editing and Host font subsets

`@deepseek-ai/libreoffice-kit-browser` shares the engine family version and has no npm OS/CPU restriction. Run `node scripts/build-browser.mjs --stage` after staging the matching WASM engine; it copies verified engine/source/license payloads and builds the public ESM API plus its self-contained Worker. `assets.json` declares the five fixed resources (Worker, loader, WASM, data and metadata) with byte counts and SHA-256. Verification checks direct page/tile rendering exports before packing. Browser assets belong in `release.browser`, separately from the five Node engine records in `release.packages`.

The portable `@deepseek-ai/libreoffice-kit-fonts` package stages the existing font implementation and exposes it without optional LibreOffice engine dependencies. Its `font-api.json` binds the two runtime bundles, public declarations and corresponding source files. The independent browser/font candidate is described in [the preview workflow](building.md). The Node API retains its compatible `./fonts` export and carries the independently built font-subset module and its source/license receipts. `engine/font-subset/source.json` pins HarfBuzz, harfbuzzjs and Emscripten; `scripts/build-font-subset.mjs` validates those checkouts, compiles a growing WASM heap, and verifies staged hashes. The CI composite action builds this payload once for the test matrix and makes the same verified files available to candidate packing. No production font pack is included. The Host discovers its installed fonts and supplies reusable Unicode-script subsets; see [the font API](../packages/entry/README.md).

Release qualification renders original DOC, DOCX, PPT and PPTX bytes from the exact browser archive using font subsetting from the exact Node API archive. `evidence/browser.json` records both archive hashes, source commit, each format's page count and painted pixels, isolation, subset delivery and Worker disposal. Local dirty-checkout receipts remain development evidence; publication requires a clean source checkout and all browser checks alongside every Node conversion receipt.

The same browser archive exposes `openEditor` for persistent DOCX, XLSX and PPTX models. Editing requires the packaged event-loop and input bindings in addition to tile rendering. Its independent `evidence/editor.json` records the installed browser/font hashes, source state, editing and OOXML save/reopen checks, optional native LibreOffice cross-checks, warm input latency, and browser process memory observations. Application preparation requires successful native and browser reopening for all three formats; preview-only evidence cannot qualify editing. See [the editing API](browser-editing.md) and [candidate qualification](building.md).

## Loader manifest, schema version 1

Every engine package exports `./prebuilds.json` and `./package.json`. Resolve `@deepseek-ai/libreoffice-kit-<platform>/prebuilds.json` relative to the adapter package. Its containing directory is the engine package root. All manifest file paths use `/` and are relative to that directory, never the current working directory or a source checkout. The Node API exports built ESM `./lib/index.js`, ships a separate ESM `./lib/worker.js`, and emits declarations under `./lib/types/`.

The native build recipe identifiers are `darwin-arm64`, `darwin-x64`, `linux-x64-glibc`, `linux-arm64-glibc`, `win32-x64`, and `win32-arm64`. Linux packages declare matching npm `libc` metadata. Non-glibc Linux hosts must choose WASM, not guess a native ABI. macOS and Windows require the matching optional native package; a missing package rejects without selecting WASM. Linux uses WASM when no development native package is installed or the known host glibc is below that package's recorded minimum. An installed package with an invalid manifest, missing files, a wrong architecture, or an unusable engine is an error and must not silently fall back.

Native manifest fields:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "platform": "darwin-arm64",
  "status": "unbuilt",
  "engine": {
    "kind": "native",
    "executable": "bin/libreoffice-kit",
    "programDirectory": "program"
  },
  "files": {},
  "source": null,
  "licenses": []
}
```

Windows uses `bin/libreoffice-kit.exe`. The worker loads this package's compiled LibreOfficeKit through the upstream C API. `program/` preserves the Core installation's relative resource and library paths. The manifest's `programDirectory` identifies the library directory inside it: typically `program/program` on Linux/Windows and `program/LibreOfficeDev.app/Contents/Frameworks` on macOS. Staging omits macOS's `MacOS/urelibs` build-tool alias to avoid duplicating the entire `Frameworks` directory; the source receipt records the omission. No system `soffice` executable is invoked.

The repository owns the complete payload recipe. `engine/native/configure.mjs` disables desktop galleries, templates, icon themes, Base connectivity, scripting, extensions, and Impress remote control, PDF import, help indexing, curl, WebDAV, CMIS, and LDAP. `scripts/slim-native.mjs` removes named desktop resources, developer SDK tools, PDF-import data, Quick Look extensions, Spotlight importers, disabled help/network libraries, residual LDAP libraries, Basic and Python scripting resources, notebookbars, toolbars, menubars, and launchers, strips nonessential symbols while retaining dynamic exports, and restores and verifies macOS ad-hoc signatures. Linux runtime modules covered by distribution receipts or NSS checksum files retain their authenticated bytes. `sources/payload-shaping.json` records removed paths and byte counts; source and reuse checks reject different recorded component selections, staging scripts, or slimming scripts. Writer, Calc, Impress, their filters, fonts, locale resources, and redistribution notices remain available for conversion. Native and WASM builds retain PDFium for PDF graphics embedded in OOXML, including EMF multi-format comments; the owned configure patch permits that renderer without standalone PDF import filters. The WASM patch includes PDFium's existing portable Linux platform implementation, whose source already supports Emscripten, in the link.

Native packaging retains the six-file `.ui` allowlist in [`engine/ui-resource-policy.mjs`](../engine/ui-resource-policy.mjs). WASM checks those mandatory layouts but retains ordinary `.ui` files for persistent browser editing; its VCL idle work and editing commands need resources beyond headless conversion. Both paths still remove desktop notebookbars, toolbars and menus. Missing required layouts can fail loading or make `VclBuilder` abort. Staging rejects missing mandatory layouts and an unreviewed Core revision. The policy and WASM packaging recipe are included in source receipts and engine cache identities. [UI resource requalification](ui-resources.md) describes the conversion minimizer, editor validation and Core upgrade procedure.

Other native resource exclusions remain in [`scripts/native-resource-policy.mjs`](../scripts/native-resource-policy.mjs): Java form-wizard styles, unused LDAP configuration samples, the Glade designer catalog and iOS widget themes; macOS also omits the Vulkan-only Skia denylist. These additional exclusions do not apply to WASM.

macOS staging removes the named registry inspection, UNO location and mail launcher tools. It removes `Frameworks/libunopkgapp.dylib` only when the library has no service registration and no retained Mach-O consumer. Staging retains both OpenSymbol font copies, language data, palettes, document themes and UI files whose apparent lack of consumers has not been established from the build and loading paths. In particular, missing `themes/Libreoffice.theme` changes the default document colors, and the `presets/` root remains necessary for fresh profile initialization. Packaging changes still require conversion qualification on each released host.

Native staging removes `share/xslt/` together with `share/registry/xsltfilter.xcd` (under `Contents/Resources/` on macOS). These registrations cover Word 2003 XML, SpreadsheetML, UOF, DocBook, and XHTML; binary DOC/XLS/PPT, OOXML, and PDF export remain supported. Staging also removes `CREDITS.fodt` from the installation root or macOS resources. It copies dependency notices into `licenses/LibreOffice-third-party.html` before pruning an installation `LICENSE.html`; only byte-identical copies are removed. Missing or different retained notices leave the installation copy intact. Other license and notice files remain.

Windows staging removes `program/wizards/`, `program/program/wizards/`, `program/program/shlxthdl/`, `program/program/shell/`, intro images, named desktop launchers, MSI custom-action DLLs, ActiveX/SharePoint integrations including `regactivex.dll`, and .NET CLI bindings and configuration files. It also removes the unused `libcrypto-3.dll` and `libssl-3.dll` pair. Excluded DLLs must be absent from `services.rdb`; a registered component rejects staging and requires Core reconfiguration. The conversion helper `bin/libreoffice-kit.exe`, scanner helper `twain32shim.exe` when present, `gpgme-w32spawn.exe`, all `.ini` files, and registered canvas, accessibility, user-info, and shell components remain. Executables outside the named removal list are retained. These packaging rules require no Core rebuild; disabling OpenSSL or registered components in configure requires a rebuilt engine and fresh conversion qualification.

Linux glibc builds record `engine.glibcMinimum` as a numeric version such as `"2.38"`. Staging derives it from the highest GLIBC version dependency of every ELF in `bin/` and `program/`, after adding bundled libraries; exported version definitions do not contribute. `GLIBC_ABI_DT_RELR` requires glibc 2.36, and unknown GLIBC capability tags reject staging. The entry validates the native identity, required assets, and minimum before comparing Node's reported host glibc. Older manifests without this optional field remain readable but cannot select fallback by version. This check does not establish compatibility with every distribution or other C++ ABIs.

The WASM manifest uses `platform: "wasm"` and this `engine` object:

```json
{
  "kind": "wasm",
  "loader": "assets/soffice.cjs",
  "wasm": "assets/soffice.wasm",
  "data": "assets/soffice.data",
  "metadata": "assets/soffice.data.js.metadata",
  "programDirectory": "/instdir/program"
}
```

Only the WASM `programDirectory` is a virtual filesystem path. Its other paths resolve relative to the installed package. The Emscripten loader exports a CommonJS factory consumed from the Node worker.

Resolve either manifest to `{ backend, packageName, packageRoot, manifest, ...paths }`. Native `paths` are `{ executablePath, programDirectory }`; WASM `paths` are `{ loaderPath, wasmPath, dataPath, metadataPath, programDirectory }`. Every `*Path` and the native `programDirectory` is absolute. This is the single artifact descriptor consumed by the entry's native process or WASM worker implementation; packaging scripts do not own runtime selection.

## Build receipts and redistribution

`status: "unbuilt"` records a target without a releasable payload. It is never installable or packable. A builder changes it to `"built"` only after staging real files. `files` maps every payload path in `bin/`, `program/`, `assets/`, `sources/`, and `licenses/` to its lowercase SHA-256 digest. Payload symlinks are rejected: staging must copy their content to preserve relocation. No unlisted payload file is allowed.

A built manifest has `source: { repository, revision, version, files }`: `repository` is an HTTPS source URL, `revision` is the full 40-character upstream commit, `version` is the LibreOffice version, and `files` is a nonempty list of packaged `sources/` paths containing the exact build recipe, shim, and patches. Every source path must also be hashed in the top-level `files` inventory. `licenses` is a nonempty list of `{ component, spdx, path }`, where `path` names a hashed text under `licenses/`. Include LibreOffice's MPL-2.0 notice and the license texts for every redistributed dependency and font. The engine builder owns source and license payloads; the entry's own license does not replace these notices.

The workspace resolves the Core URL from `.gitmodules` and the commit from the `engine/core` gitlink. Both engine packages export those values in hashed `sources/core-source.json`; the packaged pin reader uses this receipt when Git metadata is absent. Build scripts, including the WASM recipe under `sources/engine/wasm-source/`, preserve repository-relative paths. Consumers can fetch the exact upstream commit with the packaged checkout scripts without needing the superproject's `.git` directory.

Format/header unit fixtures are never release evidence. Release verification also requires real DOC, DOCX, XLS, XLSX, PPT and PPTX conversion smokes through a relocated offline installation on the corresponding host. No flag promotes fake headers or an `unbuilt` target into a release artifact.

## Native worker

The entry starts one worker per document and supplies absolute `--program-directory`, `--input-path`, `--output-path`, and `--profile-directory` paths, required `--max-output-bytes` and `--max-image-resolution` limits, and repeated `--font-file` arguments for selected fonts. `--format` selects the validated export filter, `--sheet` names the single CSV worksheet, and `--recalculate` requests synchronous whole-workbook calculation before saving. The profile and output are private to that operation. The worker returns one stdout JSON line, either `{ "ok": true, "missingFonts": [] }` or `{ "ok": false, "code": "failed", "error": "..." }`; diagnostics use stderr. Known initialization, output-limit and document-validation failures retain `unavailable`, `output-too-large` and `invalid-output` codes. The entry computes missing fonts from the source document and selected font files. Cancellation terminates the worker and waits for its exit before deleting files.

On macOS and Windows the owned Core patch initializes VCL and the Sfx application on the process main thread with unipoll. Linux uses LOKit's ordinary thread initialization. Windows restricts DLL lookup to default system locations and the packaged program directory, and requires the Microsoft Visual C++ v14 Redistributable matching the Node.js architecture, x64 or ARM64 (not bundled). Each conversion explicitly destroys its document and office handles, flushes and closes the result stream, then terminates the worker without running Core's static destructors. Writer's static clipboard teardown can otherwise query the released LOK singleton; process exit releases those remaining globals.

Font registration uses process-local CoreText on macOS, private GDI fonts on Windows, and LOKit `addfont` with an empty Fontconfig configuration on Linux. macOS/Windows can also use system fonts; the entry's font byte budgets cover explicitly selected files and do not cap all native font-library memory. The worker checks the completed output's size and deletes an oversized file before Node reads it. `maxOutputBytes` limits the returned document and its read buffer; native temporary disk files can grow until export completes. PDF image downsampling uses the configured maximum image resolution.

The entry records selected alternatives for missing document families in the conversion's private `user/registrymodifications.xcu` VCL table. Installed original and metric-compatible families are resolved by LibreOffice before that table. Native preloading requests regular faces; weight and italic selection depend on the native engine and discoverable fonts. Font priorities are defined by the entry's `fontFallbacks` option.

Native Core patches also stabilize equal-score font matching and macOS font enumeration. This prevents allocation-dependent font and word-coordinate changes between conversions on the same host; see [font determinism and qualification](native-font-determinism.md). It requires recompiling Core, and does not make different host font installations equivalent.

The owned Core patch passes `UpdateDocMode::NO_UPDATE` to document loading. The worker uses LOKit's supported `Batch=true,EnableMacrosExecution=false` options and sets an empty matching host allowlist. The DrawingML importer also leaves external picture data unloaded; embedded cached pictures remain available. These controls suppress document updates, macro execution, and LOK network host access; they do not establish an operating-system sandbox around native code.

## Public CLI and candidate qualification

The public Node CLI and runtime discovery API are documented in the [Node API reference](../packages/entry/README.md#conversion-recalculation-and-cli). They use the packaged helper or WASM engine and retain the existing component selection and macro policy. The shared native/WASM operation adapter calls the owned synchronous `calculateAll` LibreOfficeKit entry before saving recalculated workbooks; asynchronous UNO dispatch alone does not establish that cached values were refreshed.

The candidate qualification workflow reuses the WASM release builder on pull requests without triggering publication. Linux verifies the complete format matrix, cross-sheet cached results, CSV selection, and an offline CLI installation. Installation receipts separately record compressed archive bytes, installation tar bytes, and the sum of unpacked regular-file bytes (excluding symlinks and filesystem allocation); compare each measurement with the previous release. Source unit fixtures do not qualify an engine.
