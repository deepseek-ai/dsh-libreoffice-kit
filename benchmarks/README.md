# Conversion benchmarks

These descriptive benchmarks compare native LibreOfficeKit, WASM CPU, WASM WebGPU, WASM WebGL2, and WASM WebGL1 on one machine. They measure the installed public disk API. Use matching engine source revisions, font roots, input bytes, and export options; run without other owned builds or benchmarks competing for CPU and GPU resources. PDF text, fonts, and layout require separate functional validation.

Generate the fixed synthetic documents in a Python environment with `python-docx`, `openpyxl`, `python-pptx`, and `Pillow`. The generator records those package versions and its seed in `generator.json`, fixes OOXML timestamps, and writes the six input hashes to `fixtures.json`. Its DOCX and PPTX cases include images; XLSX cases contain tables and formulas without images.

```sh
python3 benchmarks/fixtures.py .build/benchmark
node benchmarks/convert.mjs \
  --manifest .build/benchmark/fixtures.json \
  --output .build/comparison \
  --native-entry /absolute/native-install/node_modules/@deepseek-ai/libreoffice-kit/src/index.js \
  --wasm-entry /absolute/wasm-install/node_modules/@deepseek-ai/libreoffice-kit/src/index.js \
  --repetitions 3
node benchmarks/report.mjs \
  --results .build/comparison \
  --manifest .build/benchmark/fixtures.json
```

Use fresh output directories and isolated package installations: the native installation contains its built platform package, and the WASM installation omits it. GPU variants request their exact provider. A missing provider or an image fixture with no accelerated operations is recorded as unavailable without timing rows. Image-free XLSX samples report `no-image-work`; their times include adapter initialization but demonstrate no GPU image acceleration. `--case FILE` selects one exact input; pass the same selection to conversion and reporting.

Each fresh sample starts a process and converter. Child processes inherit an allowlist of platform paths, home/temp directories, locale/timezone, and display connection settings; credentials, `NODE_OPTIONS`, and loader/driver overrides are omitted. The environment record describes this policy without recording values. The reported clock includes `createConverter` and `render` through closed PDF output. The reuse job creates one converter, records its first conversion separately, and measures the subsequent repetitions. Only font metadata is retained; every conversion starts a fresh native engine process or WASM Worker. Module import, PDF inspection, converter disposal, network transport, and frontend display are outside these clocks. OS disk caches are not cleared, so fresh processes do not imply a cold filesystem cache.

The controller samples aggregate RSS of the child and its descendants every 100 ms across the whole job, including import, validation, and disposal. A sampled peak can miss shorter spikes and does not measure retained memory. Fresh samples each have their own job peak; all reuse iterations share one peak. Node's own `maxRSS` excludes native descendants and is retained separately. Sampling failures and missing observations remain explicit in the report.

The reporter verifies every expected case, variant, job, iteration, input hash, requested GPU backend, and image-work count before writing `summary.json` and `report.md` exclusively. Failed, missing, or duplicate jobs reject reporting. Any unavailable job excludes that variant from timing aggregates and ratios while retaining raw evidence. Ratios divide the CPU or native median by the selected variant's median; values above one mean the variant was faster. JSON retains all clocks at their original precision, including the excluded first reuse conversion and process sampling diagnostics.

`node --test test/benchmark.test.mjs test/benchmark-report.test.mjs` checks transport, process cleanup, hand-computable statistics, missing evidence, GPU classification, and exclusive report writes without running LibreOffice performance measurements.
