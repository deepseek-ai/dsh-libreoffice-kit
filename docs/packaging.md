# Packaging

The package family shares one version. The ESM entry `@deepseek-ai/libreoffice-kit` requires `@deepseek-ai/libreoffice-kit-wasm` and lists the native packages and `webgpu` adapter as optional dependencies. Installation performs no compilation or downloads outside the package manager. All packages require Node.js >=22.19. Internal development dependencies use `workspace:*`; packing replaces those values with the exact family version in an isolated staging directory.

There is exactly one WASM package per version, without npm `os`, `cpu`, or `libc` restrictions. All hosts install identical loader, `.wasm`, and resource-data bytes. WebGPU and WebGL select optional native GPU bindings at runtime; neither requires a different LibreOffice WASM build. The complete release contains the shared WASM tarball once alongside the native platform tarballs. Verification on multiple hosts installs that same candidate without rebuilding it.

## Loader manifest, schema version 1

Every engine package exports `./prebuilds.json` and `./package.json`. Resolve `@deepseek-ai/libreoffice-kit-<platform>/prebuilds.json` relative to the entry package. Its containing directory is the engine package root. All manifest file paths use `/` and are relative to that directory, never the current working directory or a source checkout. The entry exports ESM `./src/index.js` and declarations `./src/index.d.ts`.

The native platform identifiers are `darwin-arm64`, `darwin-x64`, `linux-x64-glibc`, `linux-arm64-glibc`, `linux-x64-musl`, `linux-arm64-musl`, `win32-x64`, and `win32-arm64`. Linux packages declare matching npm `libc` metadata. Unknown libc must choose WASM, not guess a native ABI. A missing matching optional package or a known host glibc below the package's recorded minimum chooses the required shared WASM package. An installed package with an invalid manifest, missing files, a wrong architecture, or an unusable engine is an error and must not silently fall back.

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

Only the WASM `programDirectory` is a virtual filesystem path. Its other paths resolve relative to the installed package. The Emscripten loader exports a CommonJS factory consumed from the Node worker. Optional `graphics` entries map an `os-arch` platform to its hashed binding, ANGLE libraries, source files and build receipt. Graphics files reside under `assets/graphics/<os>-<arch>/`; entries do not imply a usable hardware device. CPU execution remains available when optional GPU adapters are unavailable.

Resolve either manifest to `{ backend, packageName, packageRoot, manifest, ...paths }`. Native `paths` are `{ executablePath, programDirectory }`; WASM `paths` are `{ loaderPath, wasmPath, dataPath, metadataPath, programDirectory }`. Every `*Path` and the native `programDirectory` is absolute. This is the single artifact descriptor consumed by the entry's native process or WASM worker implementation; packaging scripts do not own runtime selection.

## Build receipts and redistribution

`status: "unbuilt"` records a target without a releasable payload. It is never installable or packable. A builder changes it to `"built"` only after staging real files. `files` maps every payload path in `bin/`, `program/`, `assets/`, `sources/`, and `licenses/` to its lowercase SHA-256 digest. Payload symlinks are rejected: staging must copy their content to preserve relocation. No unlisted payload file is allowed.

A built manifest has `source: { repository, revision, version, files }`: `repository` is an HTTPS source URL, `revision` is the full 40-character upstream commit, `version` is the LibreOffice version, and `files` is a nonempty list of packaged `sources/` paths containing the exact build recipe, shim, and patches. Every source path must also be hashed in the top-level `files` inventory. `licenses` is a nonempty list of `{ component, spdx, path }`, where `path` names a hashed text under `licenses/`. Include LibreOffice's MPL-2.0 notice and the license texts for every redistributed dependency and font. The engine builder owns source and license payloads; the entry's own license does not replace these notices.

Format/header unit fixtures are never release evidence. Release verification also requires a real OOXML-to-PDF smoke through a relocated offline installation on the corresponding host. No flag promotes fake headers or an `unbuilt` target into a release artifact.

## Native worker

The entry starts one worker per document and supplies absolute `--program-directory`, `--input-path`, `--output-path`, and `--profile-directory` paths, required `--max-output-bytes` and `--max-image-resolution` limits, and repeated `--font-file` arguments for selected fonts. The profile and output are private to that conversion. The worker returns one stdout JSON line, either `{ "ok": true, "missingFonts": [] }` or `{ "ok": false, "code": "failed", "error": "..." }`; diagnostics use stderr. Known initialization, output-limit and PDF-validation failures retain `unavailable`, `output-too-large` and `invalid-output` codes. The entry computes missing fonts from the source document and selected font files. Cancellation terminates the worker and waits for its exit before deleting files.

On macOS the owned Core patch initializes Cocoa and the Sfx application on the process main thread. Linux and Windows use LOKit's ordinary thread initialization. Each conversion explicitly destroys its document and office handles, flushes and closes the result stream, then terminates the worker without running Core's static destructors. Writer's static clipboard teardown can otherwise query the released LOK singleton; process exit releases those remaining globals.

Font registration uses process-local CoreText on macOS, private GDI fonts on Windows, and LOKit `addfont` with an empty Fontconfig configuration on Linux. macOS/Windows can also use system fonts; the entry's font byte budgets cover explicitly selected files and do not cap all native font-library memory. The worker checks the completed PDF's size and deletes an oversized file before Node reads it. `maxOutputBytes` limits the returned PDF and its read buffer; native temporary disk files can grow until export completes. PDF image downsampling uses the configured maximum image resolution.

The owned Core patch passes `UpdateDocMode::NO_UPDATE` to document loading. The worker uses LOKit's supported `Batch=true,EnableMacrosExecution=false` options and sets an empty matching host allowlist. These controls suppress document updates, macro execution, and LOK network host access; they do not establish an operating-system sandbox around native code.

Engine archives omit filesystem owner names and use zero numeric owner IDs. Release evidence must also omit local workspace paths and Office last-modifier metadata; publish fresh checksums when redacting an existing archive.
