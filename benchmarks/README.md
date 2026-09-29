# Conversion benchmarks

English | [中文](README.zh.md)

These descriptive benchmarks compare native LibreOfficeKit and WASM CPU on one machine. They measure the installed public disk API. Use matching engine source revisions, font roots, input bytes, and export options, and run without other owned builds or benchmarks competing for CPU resources. PDF text, fonts, and layout require separate functional validation.

Generate the fixed synthetic documents in a Python environment with `python-docx`, `openpyxl`, `python-pptx`, and `Pillow`. The generator records those package versions and its seed in `generator.json`, fixes OOXML timestamps, and writes the six input hashes to `fixtures.json`. Its DOCX and PPTX cases include images; XLSX cases contain tables and formulas without images.

```sh
python3 benchmarks/fixtures.py .build/benchmark
node benchmarks/convert.mjs \
  --manifest .build/benchmark/fixtures.json \
  --output .build/comparison \
  --native-entry /absolute/native-install/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js \
  --wasm-entry /absolute/wasm-install/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js \
  --repetitions 3
node benchmarks/report.mjs \
  --results .build/comparison \
  --manifest .build/benchmark/fixtures.json
```

Use fresh output directories and isolated package installations: the native installation contains its built platform package, and the WASM installation omits it. `--case FILE` selects one exact input; pass the same selection to conversion and reporting.

Each fresh sample starts a process and converter. Child processes inherit an allowlist of platform paths, home/temp directories, locale/timezone, and display connection settings; credentials, `NODE_OPTIONS`, and loader/driver overrides are omitted. The environment record describes this policy without recording values. The reported clock includes `createConverter` and `render` through closed PDF output. The reuse job creates one converter, records its first conversion separately, and measures the subsequent repetitions. Only font metadata is retained; every conversion starts a fresh native engine process or WASM Worker. Module import, PDF inspection, converter disposal, network transport, and frontend display are outside these clocks. OS disk caches are not cleared, so fresh processes do not imply a cold filesystem cache.

The controller samples aggregate RSS of the child and its descendants every 100 ms across the whole job, including import, validation, and disposal. A sampled peak can miss shorter spikes and does not measure retained memory. Fresh samples each have their own job peak; all reuse iterations share one peak. Node's own `maxRSS` excludes native descendants and is retained separately. Sampling failures and missing observations remain explicit in the report.

The reporter verifies every expected case, variant, job, iteration, and input hash before writing `summary.json` and `report.md` exclusively. Failed, missing, or duplicate jobs reject reporting. Ratios divide the native median by the selected variant's median; values above one mean the variant was faster. JSON retains all clocks at their original precision, including the excluded first reuse conversion and process sampling diagnostics.

`node --test test/benchmark.test.mjs test/benchmark-report.test.mjs` checks transport, process cleanup, hand-computable statistics, missing evidence, and exclusive report writes without running LibreOffice performance measurements.

Published evidence must redact local workspace paths and omit archive account names, numeric owners, and filesystem extended attributes. Office fixtures clear the last-modifier field inherited from writer templates. Metadata-only changes to existing evidence require current checksums and a record connecting the redacted files to the original measurements; they do not constitute a new benchmark run.

## Font metadata cache comparisons

Candidate-engine tests and offline installed-package qualification run [cache content checks](../test/runtime-render-content.mjs) with disk caching disabled, an empty disk cache, a fresh converter reading that cache, and the same converter reused in memory. Each state converts the three color-block fixtures to PDF, renders the PDF through PDFium, and paints Office PNGs directly. Decoded pixels, geometry, and missing-font reports must match the disabled-cache control, and the control must contain the expected visible colors and text. Every comparison uses the candidate's actual adapter and engine; intentional engine rendering changes do not compare against obsolete pixels. These checks verify output equality, while cache-hit unit tests and the measurements below cover avoided metadata work.

For historical measurements, `font-cache.mjs` measures two built adapters against the same installed engine. `font-cache-regression.mjs` separately compares every PDF page and direct PNG, including a second baseline run to detect unstable fixtures. The recorded baseline is `96cc7d8` (its tree equals `2ba08c5`), using the `0.0.3` engine. Build each checkout with `pnpm build:adapter`, then stage their `packages/entry` directories with `font-cache-stage.mjs --baseline <baseline-package> --candidate <candidate-package> --dependencies <installed-node_modules> --output <new-directory>`. The dependency directory must contain fontkit, fflate, saxes, and the host engine. Add `--reuse-engines` when adapter versions differ: staging copies the engine privately for each adapter, verifies its complete recipe against that checkout, and changes only package/prebuild versions. Changed engine recipes reject; installed packages and engine payload bytes remain untouched.

For public inputs, download [Carlito Regular at its fixed revision](https://raw.githubusercontent.com/google/fonts/07ace6abab87a122865e5cb82c7540b39551edb2/ofl/carlito/Carlito-Regular.ttf) into a private scratch directory. The font is distributed under the [SIL Open Font License](https://github.com/google/fonts/blob/07ace6abab87a122865e5cb82c7540b39551edb2/ofl/carlito/OFL.txt); do not commit the downloaded file. `font-cache-fixtures.mjs` verifies SHA-256 `f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595` and generates DOCX/PPTX/XLSX inputs using that font:

```sh
node benchmarks/font-cache-fixtures.mjs --font /tmp/kit-benchmark/Carlito-Regular.ttf --output /tmp/kit-benchmark/fixtures
python3 -m pip install PyMuPDF==1.26.5 Pillow==11.3.0 numpy==2.0.2
node benchmarks/font-cache-regression.mjs --baseline /tmp/kit-benchmark/staged/baseline/lib/index.js --candidate /tmp/kit-benchmark/staged/candidate/lib/index.js --manifest /tmp/kit-benchmark/fixtures/inputs.json --output /tmp/kit-benchmark/regression
node benchmarks/font-cache.mjs --baseline /tmp/kit-benchmark/staged/baseline/lib/index.js --candidate /tmp/kit-benchmark/staged/candidate/lib/index.js --manifest /tmp/kit-benchmark/fixtures/inputs.json --output /tmp/kit-benchmark/performance --repetitions 7
```

The manifest is an array of `{ "id": "anonymous-case", "path": "/absolute/input.docx", "options": { "fontDirectories": ["/absolute/fonts"] } }` entries; options are optional. Regression uses these per-case options. Performance uses default system/Office discovery to measure installed-font startup. Run the commands serially on an otherwise idle host; do not clear OS caches. Fresh empty-cache and fresh disk-hit jobs alternate baseline/candidate order for at least seven pairs per input. Same-process reuse uses seven process pairs with two operations each; different-document sequences use seven process pairs. Concurrency 1/2/4 is measured separately for empty-cache and disk-hit starts, with one pair per configuration; those concurrency observations are descriptive, not seven-pair estimates.

Worker-only diagnostic instrumentation counts synchronous font bytes, read calls, metadata inspect calls, and completed scans in both variants. Both clocks include converter creation, rendering, and PDF read/header validation, and exclude module import, disposal, and forced GC. The instrumentation adds overhead; compare both variants under the same hooks. Report median and full range rather than selecting favorable samples. Disk-hit metadata inspect counts must be zero, and simultaneous first operations must share one scan.

The process-tree RSS sampler runs every 100 ms on POSIX and reports missing support on Windows. Parent `heapUsed`, `external`, `arrayBuffers`, and RSS are saved before work, at completion, after GC, and after disposal/GC. RSS is neither reachable JavaScript memory nor font buffer ownership; allocator and OS caches can retain pages after objects become unreachable. A flat or elevated RSS alone does not establish a leak.

All work directories are private. Historical regression output includes private PDFs, images, paths, text-bearing manifests, and diagnostic fingerprints; performance jobs also retain private paths, PDFs, and caches. Publish only reviewed `samples.json`, `environment.json`, regression `summary.json`, and anonymous statistics. Candidate qualification artifacts contain only the repository-authored color-block inputs and their rendered outputs, without font or cache files. Pixel equality on these fixtures is bounded evidence, not a guarantee for all documents.

For real container coverage, `font-cache-formats.mjs <font-directory>` runs the built source scanner and checks cold/disk/memory metadata and matching equality, including zero font-read bytes on hits. Use Carlito above, plus `test/data/NotoSans/NotoSans.dfont`, `test/data/NotoSans/NotoSans.ttc`, and `test/data/SourceSansPro/SourceSansPro-Regular.otf` from [fontkit revision fbf3b9ef](https://github.com/foliojs/fontkit/tree/fbf3b9ef21eebd219eb73e666faed573af0fba09/test/data). Their licenses are adjacent in that source tree. Copy the TTC fixture to an `.otc` filename to exercise both extensions of the same OpenType collection; this does not claim coverage of every collection encoding. Expected SHA-256 values are `6140d7b03a3b1e9b0f3ec6289f1fdf82c30fbb2f27ac97ff53734ce77c162ed6` (dfont), `ce7c37270d8ab52e445a86ca532bf1864043a4d43f138d83183cdb415ffc994a` (collection), and `e9eefd0655161b5558b4caf1a0667b3931c55ef8e06b58b034e8955190261d99` (OTF).

After measurement, run `node benchmarks/font-cache-report.mjs <performance-output>` to validate sample completeness, cache-hit inspect counts, and concurrent scan counts and produce `summary.json`. `font-cache-phases.mjs --candidate <entry.js> --manifest <inputs.json> --cache <warm-cache-directory> --output <new-directory>` separately measures the metadata Worker's creation-to-exit time for seven repeated operations after an initial operation per input. Run this diagnostic after the paired timings, without other local tests or benchmarks. It helps attribute the cost of re-discovery and validation; it is not a replacement for paired end-to-end measurements.
