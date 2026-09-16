# Native font matching determinism

Repeated conversions of the same document on the same macOS host could embed ArialMT or Helvetica, changing line metrics and word coordinates. A fresh process and profile did not prevent this. The public Node API reproduced it too, so PDF timestamps and the test harness's font configuration did not explain the difference.

## Cause and correction

Two order-dependent decisions in the pinned Core were involved:

1. `PhysicalFontCollection::FindFontFamilyByAttributes` iterates an unordered map. After scoring candidate families, equal-score candidates with the same default/standard preference were selected according to traversal order. The native patch preserves scoring and `Default > Standard > other` priority, and resolves remaining ties by normalized family name.
2. On macOS, `CoreTextFontFace::GetFontId` is a descriptor address. `SystemFontList::AnnounceFonts` iterated a map keyed by these addresses, so allocation order changed font insertion between processes. This also affected aliases: `PhysicalFontCollection::Add` reads aliases only from the first face of each family. For example, whether the configured `MS Mincho -> Hiragino Mincho ProN W3` replacement could resolve affected subsequent CJK fallback. The patch announces faces in PostScript-name and font-URL order, stabilizing first-face alias extraction and equal-quality duplicate selection without parsing every face's aliases.

The change is in `engine/native/patches/0031-deterministic-font-matching.patch`. It does not force documents to use Arial, override installed original fonts, or promise identical output across different operating systems or font installations. Missing-family choices can change once when moving from the old arbitrary order to the fixed order. WASM is outside this native patch's scope.

This is a Core compilation change. Build new native engines; repackaging an existing engine or rebuilding only the helper cannot apply it. Native patch discovery includes it in build identities and redistributed source receipts.

## Regression checks

The patch adds a C++ test that tries all six insertion orders of three equally suitable synthetic font families. With the old VCL library it fails (`tiealpha` expected, `tiegamma` selected). The patched `VclPhysicalFontCollectionTest` suite passes all 31 tests.

`test/runtime-native-font-determinism.test.mjs` uses the public converter with a themed multilingual DOCX and the five committed DOC/XLS/XLSX/PPT/PPTX fixtures. It renders each six times, using a new helper/profile per render, and compares page geometry, ordered text, every word box, and PDF font identities. PDF timestamps, subset prefixes and object numbers are excluded. It deliberately does not pin a particular host's fallback fonts. The old engine failed on the third DOCX conversion, switching Helvetica to ArialMT.

After building and installing a matching native package next to the adapter, run:

```sh
pnpm run build:adapter
LIBREOFFICE_RUNTIME_ENTRY="$PWD/packages/entry/lib/index.js" \
LIBREOFFICE_VALIDATION_DIR="$PWD/.build/font-validation" \
node --test test/runtime-native-font-determinism.test.mjs test/runtime-native-font-substitutions.test.mjs
```

Poppler's `pdftotext` and `pdffonts` must be on `PATH`. macOS native CI runs these checks and retains PDFs, bounding-box XML and font reports as a separate artifact. The substitution test also checks that configured missing-family replacements work and installed originals retain their own fonts.

## Local qualification

The investigation used macOS arm64, Core `bce0998afefdbc355585ca324285661a2170ba77`, and an isolated incremental rebuild of `libvcllo.dylib` and `libvclplug_osxlo.dylib`. This is local regression evidence, not a release-qualified package. Windows and macOS x64 still need their matching CI builds.

The supplementary ten-file corpus covers all six Office formats, Chinese, Japanese, Thai, a 150-paragraph DOCX and a 1,000-row XLSX. Each trial copies its input into a private directory to prevent Office lock files from interfering. The accompanying [qualification report](native-font-determinism-validation.json) records input and library hashes, repeated-layout counts, and the comparison against an isolated copy retaining only the five `.ui` resources proposed in PR #9. Resource slimming remains a separate packaging change.
