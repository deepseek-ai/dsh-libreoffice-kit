# Building and qualifying engines

Use the source pin and recipes from the checkout being built. Keep the upstream
`engine/core` submodule pristine: checkout helpers prepare disposable copies in
`.build/`. Retain the matching source recipes, reviewed patches, build instructions,
and license notices in every distributed engine package. See [packaging.md](packaging.md).

## Build Core

Install the Node.js and pnpm versions required by the workspace manifests, then run
`pnpm install --frozen-lockfile`. Build one platform at a time and pass an explicit
`--jobs` value chosen for the host's available CPU and memory. Use separate build
directories for different architectures. Installation and conversion never build
or download an engine.

- Windows: use PowerShell, a matching Visual Studio C++ developer environment,
  the Windows SDK, native Windows Python, and Cygwin build tools. Pass the Cygwin
  directory to `engine/native/bootstrap-windows.ps1`; its environment output can
  be loaded into the current build process. Override `LIBREOFFICE_KIT_CYGWIN`,
  `LIBREOFFICE_KIT_MAKE`, and `LIBREOFFICE_KIT_VISUAL_STUDIO` when required.
- macOS: select a full Xcode installation and install GNU Make, pkg-config,
  autoconf, automake, libtool, gperf, bison, flex, gettext, Ninja, nasm and Python.
  Match the host architecture to the target, or use the recipe's explicit,
  supported cross-compilation option. Confirm tool versions against the pinned Core.
- WASM: `scripts/checkout-wasm.mjs` prepares the pinned Core and Emscripten SDK.
  `engine/wasm-source/build.mjs --help` lists its build stages and path options.
  Supply an explicit job count and retain the source/toolchain pins.

For native targets, `node scripts/checkout-core.mjs` prepares the source and
`node scripts/build-native.mjs --platform <target> --jobs <count>` builds it.
Use `--source`, `--build`, and `--tarballs` for caller-selected directories.
Windows ARM64 cross-builds also require the matching MSVC environment and `--cross`.
Consult each recipe before selecting a development target that is not released.

Automated Core compilation requires more than four vCPUs on every platform and
at least sixteen on Windows. `scripts/verify-core-build-resources.mjs` checks
capacity; choose a suitable runner without relying on a particular vendor or host.

## Validate and package

Run `pnpm verify:metadata`, `pnpm test`, and `pnpm test:packaging` for source checks.
Build the adapter with `pnpm build:adapter`. Engine-backed tests additionally need
`LIBREOFFICE_RUNTIME_ENTRY` pointing to the built adapter and an installed matching
engine. A metadata declaration alone does not qualify an engine.

Use the workspace's `release:pack`, `release:verify-packed-install`, and
`release:audit` commands on prepared candidate directories. Check each declared
engine on a matching host, using the exact bytes that will be distributed. Preserve
source/version/hash, architecture, conversion, cancellation, and rendering evidence.
Repeat qualification when engine or package bytes change; do not reuse stale receipts.

Publication requires the matching source tag, complete qualified artifacts, and
credentials supplied by the release operator. Keep credentials, personal paths,
private documents, and machine-specific measurement results outside the source tree
and release payloads. The repository does not include deployment-specific runner
provisioning or account-specific dispatch rules.
