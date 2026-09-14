# Packaging

Source package manifests name the source repository. During GitHub Actions packing, `GITHUB_REPOSITORY` and the HTTPS origin `GITHUB_SERVER_URL` identify the repository that builds the release. The packer changes only disposable staging manifests; source manifests and executable payload modes remain unchanged. Local packing without workflow identity retains the source metadata. Invalid or missing workflow identity fails before any tarball is written.

The engine family shares version `0.0.1` and distributes `@deepseek-ai/libreoffice-kit-*` tarballs through the internal `deepseek-harness/libreoffice-kit` Releases. The Node API [`@deepseek-ai/dsh-libreoffice-kit`](../packages/entry/README.md) has API version `0.1.5-rc.2` and pins engines through `ENGINE_VERSION`. Its required WASM and optional macOS ARM64 dependencies use `workspace:*`; pnpm packing records fixed internal Release URLs. Application builders prepare authenticated downloads through the [release workflow](building.md) and bundle the workspace or local tarballs. Anonymous npm installation cannot fetch these dependencies. Runtime conversion performs no download or compilation and needs no GitHub credential. All packages require Node.js >=22.19.

The internal preview declares shared WASM and `darwin-arm64`. Application preparation selects macOS ARM64 for matching consumers and WASM for every consumer. The complete release candidate contains both engines. The other native build recipes remain development tooling; adding a native release target requires an adapter optional dependency and matching-host qualification.

Development archives may contain a subset of engine tarballs. Offline verification installs the candidate's staged Node API tarball; a rehearsal without one packs the adapter that `pnpm run build:adapter` already produced and fails when that build is missing. It installs the adapter's selected native engine and required shared WASM engine while omitting other optional engines. Pack the Node API with `pnpm run build:adapter --pack <candidate>` after packing engines. Publication includes that exact tarball and binds it to every host receipt.

There is exactly one WASM package per version, without npm `os`, `cpu`, or `libc` restrictions. All hosts install identical loader, `.wasm`, and resource-data bytes. The complete preview release contains one shared WASM tarball and one macOS ARM64 tarball. Verification on multiple hosts installs that same candidate without rebuilding it.

## Loader manifest, schema version 1

Every engine package exports `./prebuilds.json` and `./package.json`. Resolve `@deepseek-ai/libreoffice-kit-<platform>/prebuilds.json` relative to the adapter package. Its containing directory is the engine package root. All manifest file paths use `/` and are relative to that directory, never the current working directory or a source checkout. The Node API exports built ESM `./lib/index.js`, ships a separate ESM `./lib/worker.js`, and emits declarations under `./lib/types/`.

The native build recipe identifiers are `darwin-arm64`, `darwin-x64`, `linux-x64-glibc`, `linux-arm64-glibc`, `win32-x64`, and `win32-arm64`. Linux packages declare matching npm `libc` metadata. Non-glibc Linux hosts must choose WASM, not guess a native ABI. A missing matching optional package or a known host glibc below the package's recorded minimum chooses the required shared WASM package. An installed package with an invalid manifest, missing files, a wrong architecture, or an unusable engine is an error and must not silently fall back.

Native manifest fields:

```json
{
  "schemaVersion": 1,
  "version": "0.0.1",
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

The repository owns the complete payload recipe. `engine/native/configure.mjs` disables desktop galleries, templates, icon themes, Base connectivity, scripting, extensions, and Impress remote control, PDF import, help indexing, curl, WebDAV, and CMIS. `scripts/slim-native.mjs` removes named desktop resources, developer SDK tools, PDF-import data, Quick Look extensions, Spotlight importers, disabled help/network libraries, and launchers, strips nonessential symbols while retaining dynamic exports, and restores and verifies macOS ad-hoc signatures. Linux runtime modules covered by distribution receipts or NSS checksum files retain their authenticated bytes. `sources/payload-shaping.json` records removed paths and byte counts; source and reuse checks reject different recorded component selections, staging scripts, or slimming scripts. Writer, Calc, Impress, their filters, fonts, locale resources, and redistribution notices remain available for conversion.

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

Format/header unit fixtures are never release evidence. Release verification also requires a real OOXML-to-PDF smoke through a relocated offline installation on the corresponding host. No flag promotes fake headers or an `unbuilt` target into a release artifact.

## Native worker

The entry starts one worker per document and supplies absolute `--program-directory`, `--input-path`, `--output-path`, and `--profile-directory` paths, required `--max-output-bytes` and `--max-image-resolution` limits, and repeated `--font-file` arguments for selected fonts. The profile and output are private to that conversion. The worker returns one stdout JSON line, either `{ "ok": true, "missingFonts": [] }` or `{ "ok": false, "code": "failed", "error": "..." }`; diagnostics use stderr. Known initialization, output-limit and PDF-validation failures retain `unavailable`, `output-too-large` and `invalid-output` codes. The entry computes missing fonts from the source document and selected font files. Cancellation terminates the worker and waits for its exit before deleting files.

On macOS the owned Core patch initializes Cocoa and the Sfx application on the process main thread. Linux and Windows use LOKit's ordinary thread initialization. Each conversion explicitly destroys its document and office handles, flushes and closes the result stream, then terminates the worker without running Core's static destructors. Writer's static clipboard teardown can otherwise query the released LOK singleton; process exit releases those remaining globals.

Font registration uses process-local CoreText on macOS, private GDI fonts on Windows, and LOKit `addfont` with an empty Fontconfig configuration on Linux. macOS/Windows can also use system fonts; the entry's font byte budgets cover explicitly selected files and do not cap all native font-library memory. The worker checks the completed PDF's size and deletes an oversized file before Node reads it. `maxOutputBytes` limits the returned PDF and its read buffer; native temporary disk files can grow until export completes. PDF image downsampling uses the configured maximum image resolution.

The entry records selected alternatives for missing document families in the conversion's private `user/registrymodifications.xcu` VCL table. Installed original and metric-compatible families are resolved by LibreOffice before that table. Native preloading requests regular faces; weight and italic selection depend on the native engine and discoverable fonts. Font priorities are defined by the entry's `fontFallbacks` option.

The owned Core patch passes `UpdateDocMode::NO_UPDATE` to document loading. The worker uses LOKit's supported `Batch=true,EnableMacrosExecution=false` options and sets an empty matching host allowlist. These controls suppress document updates, macro execution, and LOK network host access; they do not establish an operating-system sandbox around native code.
