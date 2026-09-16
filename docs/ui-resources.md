# Headless UI resource qualification

Native installations and the WASM `soffice.data` image retain only these paths
under `share/config/soffice.cfg` (`Contents/Resources/config/soffice.cfg` on macOS):

| Path | Headless consumer |
| --- | --- |
| `modules/scalc/ui/inputbar.ui` | Calc formula bar |
| `modules/scalc/ui/posbox.ui` | Calc name box |
| `modules/simpress/ui/tabviewbar.ui` | Impress slide view tabs |
| `svt/ui/scrollbars.ui` | Scrollbar adaptor |
| `svt/ui/tabbuttons.ui` | Tab bar buttons |

These are `InterimItemWindow` shell views. Headless conversion still constructs
them; `VclBuilder` can abort the process when a required layout is missing. The
shared [policy](../engine/ui-resource-policy.mjs) checks their presence and removes
every other `.ui` file below this root. It does not remove other file types or
layouts outside this root. Existing toolbar, menubar and image policies still apply.

The initial investigation reported 1,021 layouts reduced to five (about 9 KB),
removing 1,016 files / 13.58 MiB from the native installation and about 13.7 MiB
from WASM data. The reported xz saving was only about 1.4 MiB: the main benefit is
installed size. Ten DOC/DOCX/XLS/XLSX/PPT/PPTX samples, including Thai, Chinese,
Japanese and large reports, had identical text and word coordinates. Counts and
sizes depend on the input build and earlier packaging exclusions; the minimizer
records exact bytes for each run instead of enforcing those historical totals.

The implementation was checked locally on 2026-09-16 against existing Core
`bce0998afefdbc355585ca324285661a2170ba77` builds:

| Measurement | Result |
| --- | --- |
| Native, incremental to the existing `main` exclusions | 1,021 → 5 layouts; 14,244,013 bytes removed (13.58 MiB) |
| WASM, incremental to the existing repacked data image | 1,030 → 5 layouts; 14,370,796 bytes removed (13.71 MiB) |
| WASM data image | 24,073,052 → 9,702,256 bytes |
| Five retained layouts in these builds | 15,076 bytes; retained bytes unchanged |
| WASM conversion comparison | All ten samples had identical ordered word text, word coordinates and page sizes |
| macOS native conversion smoke | All ten samples converted with only the five layouts present |

The local corpus combined the five checked-in binary/OOXML fixtures with generated
Chinese, Japanese and Thai DOCX files, a 150-paragraph DOCX and a 1,000-row XLSX.
WASM ran both data images through the same `convertWithWasm` implementation, module,
host font catalog and 192-DPI export setting. Native coordinate equivalence was
**not requalified** on this host: untouched baseline runs changed font metrics and
occasionally word segmentation. The strict minimizer correctly rejected that
baseline before trying deletions. The earlier investigation's equivalence result
must not be confused with this local smoke check; matching-host native release
qualification remains required.

## Requalify after every Core upgrade

Use a complete installation from the new Core build and a matching-host native
engine package. A previously pruned package alone cannot reveal new dependencies.
The package's helper, installation and `--ui-source` must come from the same build.
Use text-bearing fixtures covering all six formats, multilingual text and large
reports. Install Python 3, Node and Poppler (`pdftotext`) on the qualification host.

```sh
python3 scripts/minimize-ui-resources.py \
  --package /absolute/native-engine-package \
  --ui-source /absolute/unpruned-install/share/config/soffice.cfg \
  --fixtures /absolute/office-corpus \
  --output .build/ui-minimization
```

On macOS `--ui-source` ends in
`LibreOfficeDev.app/Contents/Resources/config/soffice.cfg`. Pass repeatable
`--font-file /absolute/font.ttf` arguments to register the same fonts in every
helper process. Stabilize missing-font substitution before measuring: the script
rejects a baseline whose page geometry, text or word boxes change between two runs.
Use static document fields; volatile dates or external data cannot qualify exact
equivalence. The script strips credentials and loader overrides from child environments.

The script copies the engine and complete UI tree into a new output directory. It
deletes only from that copy, tries directories before individual files, restores
each rejected trial, and repeats file trials until no more removals pass. Every
trial and the final check run the corpus in fresh helper processes with separate
profiles and PDFs. Nonzero exits (including aborts), deadlines, missing words and
changed page/word geometry reject a deletion. It checks ordered word text and
coordinates, excluding PDF metadata such as creation time. This is a greedy,
corpus-specific minimum, not a proof for every document or rendering feature.

`report.json` records input/UI/font/helper hashes, Core revision, Poppler version,
all deletion decisions and failures, final retained paths and byte counts. Baseline
XML and failure logs remain local for diagnosis. The candidate copy has a changed
payload and is not a releasable package; stage it again with the normal recipe.

Review the result and update `requiredUiResources` and `reviewedUiCoreRevision`.
The reviewed revision is evidence scope; `engine/core` remains the only source
pin. Stage freshly qualified native packages on each release host and repackage
WASM from its verified compilation. Use `--mode verify` with another new output
directory to compare the checked-in allowlist directly against the complete UI
tree. Qualify the repacked WASM engine and installed native packages with the same
corpus and fonts before release; native minimization alone does not qualify WASM.

Run `pnpm verify:metadata`, `pnpm test` and `pnpm test:packaging`. Packaging hashes
and ships the shared policy; native reuse, prepared-engine validation and both
engine caches reject an old policy. WASM repacking preserves every retained byte,
rebuilds offsets/size and records original and final hashes without recompilation.
