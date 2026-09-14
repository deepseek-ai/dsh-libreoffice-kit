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

## Size reduction

The conversion build excludes desktop galleries, templates and icons, Base connectivity, scripting and extensions, PDF import, help indexing, LDAP, and unused network providers. Native packaging removes the duplicate macOS library alias, residual disabled libraries, Basic/Python scripts, notebookbars, menus, toolbars, and desktop launch/integration resources. It strips nonessential symbols, preserves dynamic exports, and verifies macOS signatures and library dependencies.

WASM packaging removes named desktop resources from its filesystem image and regenerates offsets without changing retained bytes, the loader, or the compiled module. Engine downloads use XZ; preparation verifies both the compressed transfer and the exact installation tar before the application bundles them. Fonts are supplied at runtime. Writer, Calc, Impress, PDF export, ICU, shared layout libraries, Skia, charts, source receipts, and license notices remain included.

Measured local candidate sizes below compare the preceding `0.1.2` gzip packages with the independently versioned `0.0.1` XZ packages. MB means 1,000,000 bytes; unpacked size sums regular files, excluding filesystem allocation and dependency packages.

| Engine | Previous download | Current download | Reduction | Previous unpacked | Current unpacked |
| --- | ---: | ---: | ---: | ---: | ---: |
| macOS ARM64 | 98.85 MB | 60.49 MB | 38.80% | 301.04 MB | 269.43 MB |
| CPU WASM | 56.47 MB | 35.87 MB | 36.47% | 210.24 MB | 190.61 MB |

The local macOS ARM64 validation installs the same candidate offline with native and WASM selection. Six synthetic DOCX/XLSX/PPTX documents per engine, including Chinese/English text, tables, formulas, and images, retain identical extracted text, page counts, and 96-DPI rendered pixels against the preceding packages. Runtime checks cover external-link suppression, font substitutions, limits, and cancellation. This evidence covers those fixtures and host; it is not an exhaustive document-fidelity or platform certification. See [packaging](docs/packaging.md) for archive integrity and [release qualification](docs/building.md) for the independent release workflow.

## Development

[Native sources](engine/native/) and the [Node WASM recipe](engine/wasm-source/README.md) compile the same LibreOffice revision pinned by the `engine/core` submodule. [.gitmodules](.gitmodules) records the upstream URL and the gitlink records the commit. Checkout scripts initialize the submodule as needed and create separate, patchable source trees under ignored `.build/` directories. The corresponding source recipe, resolved pin, patches, hashes, and redistribution notices travel with each engine package. This repository also owns component selection, duplicate removal, desktop-resource pruning, symbol stripping, and signing. Prepared artifacts must match the complete configure, patch, staging, and slimming recipes; no external slimming script is required. No font collection is bundled.

Run `pnpm verify:metadata`, `pnpm test`, and `pnpm test:packaging` in this directory; none of them builds LibreOffice. Native and WASM payloads are built on the matching CI runners declared by `pnpm gha:matrix`.

[Benchmarks](benchmarks/README.md) use generated documents and separate installed native and WASM layouts. They measure the public disk API and keep first font indexing separate from converter reuse. Native and WASM comparisons require the same source revision, document bytes, font roots, and PDF options. Frontend transport and painting are separate measurements.
