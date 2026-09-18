# Headless UI resource qualification

Native headless installations retain only these `.ui` layouts under
`share/config/soffice.cfg` (`Contents/Resources/config/soffice.cfg` on macOS):

| Path | Headless consumer |
| --- | --- |
| `modules/scalc/ui/inputbar.ui` | Calc formula bar |
| `modules/scalc/ui/posbox.ui` | Calc name box |
| `modules/simpress/ui/tabviewbar.ui` | Impress slide view tabs |
| `modules/swriter/ui/annotation.ui` | Writer comments in WASM |
| `svt/ui/scrollbars.ui` | Scrollbar adaptor |
| `svt/ui/tabbuttons.ui` | Tab bar buttons |

Headless conversion still constructs the Calc/Impress and shared `InterimItemWindow`
shell views. Writer also loads `annotation.ui` for DOCX comments in WASM. Missing
required layouts can fail document loading or make `VclBuilder` abort. The
shared [policy](../engine/ui-resource-policy.mjs) checks their presence. Native
packaging removes every other `.ui` file below this root. It does not remove other
file types or layouts outside this root. Existing toolbar, menubar and image policies still apply.

The shared WASM image also powers persistent browser editing and retains ordinary
`.ui` layouts beyond this conversion allowlist. A 2026-09-18 editor smoke reproduced
an abort during the first Writer event pump with the six-layout image. The same
compiled module passed DOCX editing with the complete data image; restoring the
ordinary layouts fixes this packaging regression. Notebookbars, toolbars, menus
and image archives remain excluded. A conversion-only minimization result does
not qualify removal from the editor. Run `scripts/smoke-browser-editor.mjs` against
packed archives for DOCX/XLSX/PPTX editing, saving and reopening before release.

The initial five-layout policy omitted Writer comments. A real-engine test on
2026-09-17 confirmed that a standard commented DOCX loaded with the baseline WASM
image, failed with the five-layout image, and loaded again after restoring only
`annotation.ui` (11,021 bytes). The baseline and restored PDF rendered identically.
The shared policy therefore retains six layouts, the union required by native and
WASM conversion. `test/runtime-engine.test.mjs` includes a generated commented DOCX
in installed-engine checks; it runs when `LIBREOFFICE_RUNTIME_ENTRY` is set.

The conversion-only six-layout policy was checked locally on 2026-09-17 against
existing Core `bce0998afefdbc355585ca324285661a2170ba77` builds. Counts and sizes depend on the
input build and earlier packaging exclusions; the minimizer records exact bytes
for each run instead of enforcing these totals.

| Measurement | Result |
| --- | --- |
| Native, incremental to the existing `main` exclusions | 1,021 → 6 layouts; 14,232,992 bytes removed |
| WASM, incremental to the existing repacked data image | 1,030 → 6 layouts; 14,359,775 bytes removed |
| WASM data image | 24,073,052 → 9,713,277 bytes |
| Six retained layouts in these builds | 26,097 bytes; retained bytes unchanged |
| Annotation restoration relative to the five-layout image | One file, 11,021 bytes; all other payload bytes unchanged |
| WASM conversion | 127/128 inputs converted, including the commented DOCX |
| macOS ARM64 native smoke across all six formats | 9/10 representative inputs converted, including the commented DOCX |

The WASM corpus contained 126 distinct user inputs and two supplementary fixtures
(commented DOCX and XLS). The sole failing input in both backends also failed with
the unpruned baseline: its ZIP container uses unencrypted STORED entries with data
descriptors, rejected by the pinned Core. Restoring annotation.ui introduced no new
conversion failure. User documents and diagnostic outputs remain outside tracked
source and release payloads.

WASM used the same `convertWithWasm` implementation, module, host font catalog and
192-DPI export setting. Of 127 successful results, 126 matched the earlier baseline's
ordered word text, coordinates and page sizes. One legacy DOC differed on one line;
two alternating repeats of the unchanged baseline and restored image all matched
the new result, including the 93-page count. The commented DOCX also produced an
identical rendered PNG to baseline.

Native coordinate equivalence was **not requalified**: untouched baseline runs
changed font metrics, word segmentation and sometimes pagination. The strict
minimizer correctly rejected that unstable baseline before trying deletions.
These macOS ARM64 native and direct-WASM tests do not replace matching-host native
release qualification or Linux installation checks.

## Requalify after every Core upgrade

Use a complete installation from the new Core build and a matching-host native
engine package. A previously pruned package alone cannot reveal new dependencies.
The package's helper, installation and `--ui-source` must come from the same build.
Use text-bearing fixtures covering all six formats, standard DOCX comments,
multilingual text and large reports. Install Python 3, Node and Poppler (`pdftotext`)
on the qualification host.

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
The mandatory allowlist must cover both backends: a resource removable by native
minimization may still be required by WASM conversion. WASM editor layouts are
retained separately and require editing qualification before any further pruning.
A smaller native result does not justify removing Writer's annotation layout without a WASM comment conversion check.
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
