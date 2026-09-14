---
description: "Prebuilt LibreOfficeKit conversion engines, the required Node WASM fallback, and their platform packages."
kind: "package-library"
---
# LibreOffice engines

English | [中文](README.zh.md)

## Summary

Build and distribute precompiled LibreOffice engines for on-disk DOCX, XLSX, and PPTX conversion. This workspace owns the source pin, patches, native helper, and shared Node WebAssembly engine. The public Node API and font loading live in `packages/entry`.

The public package `@deepseek-ai/dsh-libreoffice-kit` [Node API](packages/entry/README.md) documents `createConverter`, `render`, disposal, resource limits, and fonts. Each conversion writes a fresh PDF that the caller can read and send to an existing PDF viewer.

DeepSeek Harness owns the Cordis document provider, authorization, and Web preview; this repository owns the standalone conversion API.

## Engine selection

An installed matching OS/CPU/libc package selects the native helper. An absent package, or a host glibc version below the native package's recorded minimum, selects the shared WASM engine. Corrupt installed packages and conversion failures reject rather than silently changing engines. Layout and PDF serialization are CPU work on both engines.

## Support

The internal preview declares macOS ARM64 and shared `@deepseek-ai/libreoffice-kit-wasm` engines. Other native packages remain development recipes. The repository owns its pnpm lockfile. GitHub Actions builds and verifies the declared engines, and the publisher hosts complete tarballs in the internal `deepseek-harness/libreoffice-kit` repository under `libreoffice-kit-v<version>`. Application builds authenticate downloads and bundle the prepared engines. The [packaging guide](docs/packaging.md) defines archive validation and installation limits; the [release guide](docs/building.md) covers build-time credentials, qualification, and publication.

## Development

[Native sources](engine/native/) and the [Node WASM recipe](engine/wasm-source/README.md) compile the same pinned LibreOffice revision. The workspace tracks the revision pin, the patch sets, and our own C++ and build scripts; upstream source is fetched into an ignored directory at build time, and the corresponding source, patches, hashes, and redistribution notices travel with each engine package. This repository also owns component selection, duplicate removal, desktop-resource pruning, symbol stripping, and signing. Prepared artifacts must match the complete configure, patch, staging, and slimming recipes; no external slimming script is required. No font collection is bundled.

Run `pnpm verify:metadata`, `pnpm test`, and `pnpm test:packaging` in this directory; none of them builds LibreOffice. Native and WASM payloads are built on the matching CI runners declared by `pnpm gha:matrix`.

[Benchmarks](benchmarks/README.md) use generated documents and separate installed native and WASM layouts. They measure the public disk API and keep first font indexing separate from converter reuse. Native and WASM comparisons require the same source revision, document bytes, font roots, and PDF options. Frontend transport and painting are separate measurements.
