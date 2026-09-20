# Host font subset runtime

[中文](README.zh.md)

The Node font source uses HarfBuzz to extract individual sfnt faces and preserve shaping while selecting reusable Unicode-script partitions. [source.json](source.json) pins harfbuzzjs, its HarfBuzz submodule, and Emscripten. The upstream subset module has a fixed 65 MiB heap; this recipe enables heap growth up to the WebAssembly build ceiling of 2 GiB. Input limits and the retained-subset cache budget do not bound all transient subsetting allocations.

Prepare an isolated checkout and SDK, then build:

```sh
git clone --depth 1 --branch v1.6.1 --recurse-submodules --shallow-submodules https://github.com/harfbuzz/harfbuzzjs.git .build/font-subset/harfbuzzjs
git clone https://github.com/emscripten-core/emsdk.git .build/font-subset/emsdk
git -C .build/font-subset/emsdk checkout --detach 5eb0bde7585670252e8ba05e9d361627bffd08b5
python3 .build/font-subset/emsdk/emsdk.py install 4.0.10
python3 .build/font-subset/emsdk/emsdk.py activate 4.0.10
node scripts/build-font-subset.mjs
node scripts/build-font-subset.mjs --verify
```

The build checks exact commits, clean tracked source files, and the compiler version. It changes only compiler/linker arguments: upstream source remains unmodified. `--source`, `--emsdk`, and `--target` accept existing checkout and staging directories; use a separate SDK cache when another build is active.

The generated `packages/entry/assets/font-subset.json` records the exact source pins, recipe hash, and checksums for the WASM module, source recipe, configuration, exports list, and license notices. Node API packing verifies this receipt. The runtime verifies its WASM bytes against the packaged receipt before initialization. Installation and font requests never build or fetch the module.

Build this runtime before running font subset tests. Portable fixtures compare Arabic, Indic, supplementary-script, and variable-font shaping and outlines, exercise TTC/dfont extraction, and force allocation beyond the upstream heap size. The tests also cover cache eviction, font-index refresh, worker teardown, and invalid module receipts.
