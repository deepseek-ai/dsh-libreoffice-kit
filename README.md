# LibreOffice Kit

Convert on-disk DOCX, XLSX, and PPTX files to PDF in Node.js. This repository owns the LibreOffice source patches, native helpers and platform packages, a required Node WebAssembly fallback, font loading, and optional WebGPU image scaling. It does not require a user's LibreOffice installation or a browser conversion runtime.

The [Node API](packages/entry/README.md) documents `createConverter`, `render`, disposal, resource limits, and fonts. Each conversion writes a fresh PDF that the caller can read and send to an existing PDF viewer.

An installed matching OS/CPU/libc package selects the native helper. An absent package selects WASM. Corrupt installed packages and conversion failures reject rather than silently changing engines. WASM image scaling can use a device WebGPU adapter; unsupported or failed GPU operations use the CPU filter. Layout and PDF serialization remain CPU work.

The package family follows the platform-optional-dependency approach of [node-addon-require-builtin](https://github.com/deepseek-harness/node-addon-require-builtin) and the host application. The [packaging guide](docs/packaging.md) defines artifact validation and the [release guide](docs/building.md) defines tarball assembly, offline installation, and publication. A declared target is not a successful build: release checks reject unbuilt or incomplete payloads.

[Native sources](engine/native/) and the [Node WASM recipe](engine/wasm-source/README.md) compile the same pinned LibreOffice revision. Corresponding source, patches, hashes, and redistribution notices travel with each engine package. No font collection is bundled. The initial delivery is a private repository and tarballs; npm publication is deferred.

[Benchmarks](benchmarks/) use generated documents and separate installed native/WASM layouts. They measure the public disk API, record actual GPU callback counts, and keep first font indexing separate from converter reuse. Native Core, WASM CPU, and WASM WebGPU comparisons require the same source revision, document bytes, font roots, and PDF options. Frontend transport and painting are separate measurements.
