# Packaging

Source package manifests name the source repository. During GitHub Actions packing, `GITHUB_REPOSITORY` and the HTTPS origin `GITHUB_SERVER_URL` identify the repository that builds the release. The packer changes only disposable staging manifests; source manifests and executable payload modes remain unchanged. Local packing without workflow identity retains the source metadata. Invalid or missing workflow identity fails before any tarball is written.

The engine family distributes `@deepseek-ai/libreoffice-kit-*` tarballs through the internal `deepseek-harness/libreoffice-kit` Releases. The Node API [`@deepseek-ai/libreoffice-kit`](../packages/entry/README.md) has API version `0.1.3`; `ENGINE_VERSION` reports this API version and `ENGINE_VERSIONS` pins each compatible engine version independently. Its optional WASM and macOS/Windows ARM64/x64 dependencies use `workspace:*`; pnpm packing records exact engine versions. Application builders prepare authenticated downloads through the [release workflow](building.md), override these versions with verified local installation tarballs, and bundle the engines. For public npm publication, `release:prepare-npm` derives audited standard npm archives from the same qualified candidate; see [public preparation](building.md). Runtime conversion performs no download or compilation and needs no GitHub credential. All packages require Node.js >=22.19.

The internal preview declares shared WASM, `darwin-arm64`, `darwin-x64`, `win32-arm64`, and `win32-x64`. Application preparation selects only the matching native package on macOS/Windows, and only WASM on Linux. The complete release candidate contains all five engines. The other native build recipes remain development tooling; adding a native release target requires an adapter optional dependency and matching-host qualification.

Development archives may contain a subset of engine tarballs. Offline verification installs the candidate's staged Node API tarball; a rehearsal without one packs the adapter that `pnpm run build:adapter` already produced and fails when that build is missing. By default it installs only the host engine: native on macOS/Windows, WASM on Linux. Explicit Linux development rehearsals may install both engines. Pack the Node API with `pnpm run build:adapter --pack <candidate>` after packing engines. Publication includes that exact tarball and binds it to every host receipt.

There is exactly one WASM package per version, with npm `os: ["linux"]` and no `cpu` or `libc` restrictions. Hosts that install WASM receive identical loader, `.wasm`, and resource-data bytes. The complete preview release contains one shared WASM tarball and four native tarballs for macOS and Windows on ARM64 and x64. Verification on multiple hosts installs that same candidate without rebuilding it.

Public candidates preserve matching source recipes, patches and license notices. The build recipe records the organization vendor and normalized build paths; publication gates scan the final archive contents before any upload. A privacy failure requires a new candidate and fresh qualification when its contents change.

## Download and installation archives

Engine Release assets use `.tar.xz`. Each XZ-compressed outer tar contains exactly one regular file, `package.tar`: the unchanged npm package tar before gzip compression. The release record stores `file`, `bytes`, and `sha256` for the transfer, plus `install: { file, bytes, sha256 }` for that inner tar. The install filename is the transfer filename without `.xz`. The Node API remains a conventional `.tgz`.

Preparation requires system `tar` with XZ support. It verifies the transfer size and SHA-256, rejects any envelope containing additional members, streams `package.tar` into a private file, and verifies its independent size and SHA-256 before installation. npm and pnpm install the prepared plain `.tar`; a frozen lockfile therefore does not depend on the host's gzip encoder. Application distribution may gzip that verified tar during its build and record the resulting archive hash. Runtime conversion has no XZ decoder or archive preparation step. Download bytes, installation tar bytes, and unpacked file bytes are different measurements.

WASM packaging removes named desktop resources from `soffice.data`, preserving every retained byte and metadata attribute while rebuilding offsets and total size. The loader and compiled module remain unchanged. Original compilation hashes and the packaging recipe are both recorded; [the WASM recipe](../engine/wasm-source/README.md) defines when compilation is required.

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

Windows uses `bin/libreoffice-kit.exe`. All native recipes link the bundled Core
libraries into the private helper as static archives, with generated UNO component
registration. macOS uses Mach-O dead stripping and exports `_main`; Intel also
exports UNO RTTI data required by its exception bridge's `dlsym` lookups. Hiding
that data causes ordinary caught UNO exceptions to escape document conversion.
ARM64 keeps only `_main`. Windows
removes Core and bundled-library DLL exports and uses `/Gy`, `/Gw`, `/OPT:REF` and
`/OPT:ICF`; Linux uses function/data sections, `--gc-sections` and `--exclude-libs=ALL`.
System libraries and frameworks remain dynamic, including the Windows CRT.
`program/` preserves the installed resource layout. `programDirectory` is
`program/program` on Linux/Windows and
`program/LibreOfficeDev.app/Contents/Resources` on macOS. No system `soffice` is invoked.
Staging omits macOS's duplicate `MacOS/urelibs` build-tool alias.

Skia remains enabled on macOS/Windows; Linux retains its headless renderer. PDFium
and OpenSSL remain enabled. NSS and GPGME certificate/signature and OpenPGP services
are disabled. Windows retains its native MSCNG certificate backend. The static Windows helper omits
OS accessibility and OLE server registration services; document embedded-object
processing remains available. Linked archives
and unused standalone UNO, registry, URI and Windows scanner tools are omitted. Staging removes
autocorr, autotext, wordbook, shell assets and `palette/standard.sob`. UI layouts
use the six-file allowlist in `engine/ui-resource-policy.mjs`; adjacent drawing XML
and other palettes remain. Static builds omit zxcvbn and password-strength bars,
while preserving password hashing, verification and policy checks. These policies
and all source patches enter the packaged receipts. Helper changes require relinking
Core with `build-native.mjs --resume`; standalone replacement is rejected.

All released native targets default to `-Oz` and ThinLTO; Windows uses clang-cl
and lld-link with an explicit target triple, including x64-to-ARM64 cross builds.
Build-host tools use the build machine's triple. WebP retains MSVC, and zlib
remains ordinary COFF for external projects that use the MSVC linker. These
exceptions are statically linked but are not LLVM bitcode.
`--optimization default|O2|Os|Oz` and `--lto` / `--no-lto` select comparison builds;
Windows `--msvc` selects the original MSVC policy for comparisons. Linux native
recipes remain development-only and retain their existing compiler policy.
WASM uses `-Oz` at compile and link time and full LLVM LTO through Emscripten.
Its filesystem also drops autocorrection, autotext, wordbooks, default bitmap
textures, gallery/templates/wizards and desktop start/about/tip dialogs. It keeps
persistent-editor layouts, document colors, gradients and document filters.
Both engine families omit zxcvbn and password-strength meters; password policy
checks and document cryptography are retained. Skia remains enabled on macOS and
Windows. Use separate build directories for comparison configurations and keep
those options on resume. Recipe coverage is not a successful build; every target
requires matching-host qualification.

The repository owns the complete payload recipe. `engine/native/configure.mjs` disables desktop galleries, templates, icon themes, Base connectivity, scripting, extensions, and Impress remote control, PDF import, help indexing, curl, WebDAV, CMIS, and LDAP. `scripts/slim-native.mjs` removes named desktop resources, developer SDK tools, PDF-import data, Quick Look extensions, Spotlight importers, disabled help/network libraries, residual LDAP libraries, Basic and Python scripting resources, notebookbars, toolbars, menubars, and launchers, strips nonessential symbols while retaining dynamic exports, and restores and verifies macOS ad-hoc signatures. The static Linux recipe verifies the ELF system-library closure and does not acquire NSS, NSPR or SQLite runtime payloads. `sources/payload-shaping.json` records removed paths and byte counts; source and reuse checks reject different recorded component selections, staging scripts, or slimming scripts. Writer, Calc, Impress, their filters, fonts, locale resources, and redistribution notices remain available for conversion. Native and WASM builds retain PDFium for PDF graphics embedded in OOXML, including EMF multi-format comments; the owned configure patch permits that renderer without standalone PDF import filters. The WASM patch includes PDFium's existing portable Linux platform implementation, whose source already supports Emscripten, in the link.

Native staging removes `share/xslt/` together with `share/registry/xsltfilter.xcd` (under `Contents/Resources/` on macOS). These registrations cover Word 2003 XML, SpreadsheetML, UOF, DocBook, and XHTML; binary DOC/XLS/PPT, OOXML, and PDF export remain supported. Staging also removes `CREDITS.fodt` from the installation root or macOS resources. It copies dependency notices into `licenses/LibreOffice-third-party.html` before pruning an installation `LICENSE.html`; only byte-identical copies are removed. Missing or different retained notices leave the installation copy intact. Other license and notice files remain.

Windows staging removes `program/wizards/`, `program/program/wizards/`, `program/program/shlxthdl/`, `program/program/shell/`, intro images, named desktop launchers, MSI custom-action DLLs, ActiveX/SharePoint integrations, and .NET CLI bindings and configuration files. It also removes unused standalone scanner, UNO, registry and URI tools and the unused `libcrypto-3.dll` / `libssl-3.dll` pair. Excluded DLLs must be absent from `services.rdb`; a registered component rejects staging and requires Core reconfiguration. The private helper, required `.ini` files and resources remain. Static archives are omitted after final linkage. Component-selection and linkage changes require a rebuilt engine and fresh conversion qualification.

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

The manual `libreoffice-kit-import-native.yml` workflow can reuse an existing native
build, including a cross-compiled engine. Provision a one-job runner with label
`libreoffice-kit-import-<platform>` and `LIBREOFFICE_KIT_PREBUILT_DIRECTORY` pointing
to its engine package. Supply the full repository commit matching its source
receipts. The workflow verifies every payload hash and the source recipe before
transfer, then runs conversion tests on the matching hosted architecture. Only a
successful test job uploads `core-payload-<platform>`; transfer artifacts are named
`unverified-native-<platform>`. This workflow does not publish npm or Releases.

Windows ICU builds forward the owned C++ flags into their configure command, including `_CRT_USE_BUILTIN_OFFSETOF` for SDK headers used by both the target engine and its build tools.

Windows configure reports active antivirus software without writing EICAR test
files or requiring scanner exclusions. Antivirus protection remains enabled
during compilation.

## Native worker

The entry starts one worker per document and supplies absolute input, output, profile, and program paths plus bounded conversion or raster settings. Conversion uses the existing one-result JSON protocol. Native image batches keep one helper alive, exchange bounded paint commands, and return raw tile files inside the operation scratch directory; Node validates and encodes those pixels as PNG. macOS and desktop Windows allocate a VCL canvas, paint into its backing surface, and copy BGRA pixels into the LOK output buffer. Diagnostics use stderr. An exit before a protocol response reports its status and captured diagnostics. On Windows, executable or program paths at least 260 characters long use a private helper copy and a junction to the installed resources; cleanup unlinks the junction only after the child closes. Cancellation terminates the helper and waits for exit before deleting files.

On macOS and Windows the owned Core patch initializes VCL and the Sfx application on the process main thread with unipoll. Linux uses LOKit's ordinary thread initialization. Windows restricts DLL lookup to default system locations and the packaged program directory, and requires the Microsoft Visual C++ v14 Redistributable matching the Node.js architecture, x64 or ARM64 (not bundled). Each conversion explicitly destroys its document and office handles, flushes and closes the result stream, then terminates the worker without running Core's static destructors. Writer's static clipboard teardown can otherwise query the released LOK singleton; process exit releases those remaining globals.

Font registration uses process-local CoreText on macOS, private GDI fonts on Windows, and LOKit `addfont` with an empty Fontconfig configuration on Linux. macOS/Windows can also use system fonts; the entry's font byte budgets cover explicitly selected files and do not cap all native font-library memory. The worker checks the completed PDF's size and deletes an oversized file before Node reads it. `maxOutputBytes` limits the returned PDF and its read buffer; native temporary disk files can grow until export completes. PDF image downsampling uses the configured maximum image resolution.

The entry records selected alternatives for missing document families in the conversion's private `user/registrymodifications.xcu` VCL table. Installed original and metric-compatible families are resolved by LibreOffice before that table. Native preloading requests regular faces; weight and italic selection depend on the native engine and discoverable fonts. Font priorities are defined by the entry's `fontFallbacks` option.

The owned Core patch passes `UpdateDocMode::NO_UPDATE` to document loading. The worker uses LOKit's supported `Batch=true,EnableMacrosExecution=false` options and sets an empty matching host allowlist. These controls suppress document updates, macro execution, and LOK network host access; they do not establish an operating-system sandbox around native code.

Local and SSH native builds enter Actions through `libreoffice-kit-import-native.yml`,
which tests the engine on its target architecture. `libreoffice-kit-qualify.yml`
can build WASM alone with `wasm_only`. `libreoffice-kit-collect.yml` accepts five
successful build/import run IDs and an immutable source commit, rechecks payload
hashes and corresponding recipes, and creates the complete five-artifact input
for the tagged release workflow. Collection does not replace the release workflow's
installed conversion tests and does not publish to GitHub or npm.
