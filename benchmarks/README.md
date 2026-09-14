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
