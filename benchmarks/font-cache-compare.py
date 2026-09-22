"""Compare local PDFs and PNGs without publishing document text, font names, or paths."""
import json
import re
import sys
from pathlib import Path
import fitz
import numpy as np
from PIL import Image


def pixels(a, b):
    if a.shape != b.shape:
        return {"same": False, "dimensionsMatch": False}
    diff = np.abs(a.astype(np.int16) - b.astype(np.int16))
    return {"same": not bool(diff.any()), "dimensionsMatch": True,
            "differentChannels": int(np.count_nonzero(diff)), "maxDelta": int(diff.max(initial=0))}


def pdf_compare(a, b):
    with fitz.open(a) as first, fitz.open(b) as second:
        if len(first) != len(second):
            return {"same": False, "pageCounts": [len(first), len(second)]}
        pages = []
        for x, y in zip(first, second):
            fonts = lambda page: sorted((re.sub(r"^[A-Z]{6}\+", "", f[3]), f[1], f[2], f[5]) for f in page.get_fonts())
            raster = lambda page: np.frombuffer(page.get_pixmap(matrix=fitz.Matrix(96 / 72, 96 / 72), alpha=False).samples, dtype=np.uint8)
            row = {"page": len(pages) + 1, "dimensionsMatch": x.rect == y.rect,
                   "textMatch": x.get_text() == y.get_text(), "fontsMatch": fonts(x) == fonts(y),
                   "pixels": pixels(raster(x), raster(y))}
            pages.append(row)
        return {"same": all(p["dimensionsMatch"] and p["textMatch"] and p["fontsMatch"] and p["pixels"]["same"] for p in pages), "pages": pages}


def compare(a, b):
    observed_a = json.loads((a / "observed.json").read_text())
    observed_b = json.loads((b / "observed.json").read_text())
    pdf = pdf_compare(a / "output.pdf", b / "output.pdf")
    m1 = json.loads((a / "direct/manifest.json").read_text())
    m2 = json.loads((b / "direct/manifest.json").read_text())
    direct = {"pageCountsMatch": m1["pageCount"] == m2["pageCount"], "imageCountsMatch": len(m1["images"]) == len(m2["images"]), "images": []}
    for x, y in zip(m1["images"], m2["images"]):
        with Image.open(x["path"]) as im1, Image.open(y["path"]) as im2:
            direct["images"].append({"geometryMatch": all(x.get(k) == y.get(k) for k in ["width", "height", "rectangle", "page", "sheet", "range", "rtl"]),
                                     "pixels": pixels(np.array(im1.convert("RGBA")), np.array(im2.convert("RGBA")))})
    direct["same"] = direct["pageCountsMatch"] and direct["imageCountsMatch"] and all(i["geometryMatch"] and i["pixels"]["same"] for i in direct["images"])
    fields = {key + "Match": observed_a[key] == observed_b[key] for key in observed_a}
    # Matching-cache exports may accumulate codepoints on repeated operations; original imported bytes remain compared.
    return {"same": pdf["same"] and direct["same"] and all(fields.values()), "metadataAndDiagnostics": fields, "pdf": pdf, "direct": direct}


root = Path(sys.argv[1])
results = []
for case in json.loads((root / "runs.json").read_text()):
    row = {"id": case["id"], "runsCompleted": all(r["exitCode"] == 0 and not r["killed"] and not r["failed"] for r in case["runs"])}
    if row["runsCompleted"]:
        directory = root / case["id"]
        baseline = directory / "baseline-0/0"
        row["baselineRepeat"] = compare(baseline, directory / "baseline-1/0")
        row["comparisons"] = {mode: compare(baseline, directory / mode) for mode in ["empty/0", "disk/0", "memory/0", "memory/1", "disabled/0"]}
        row["same"] = row["baselineRepeat"]["same"] and all(r["same"] for r in row["comparisons"].values())
    else:
        row["same"] = False
    results.append(row)
(root / "summary.json").write_text(json.dumps(results, indent=2) + "\n")
for row in results:
    print(row["id"], "identical" if row["same"] else "requires investigation")
sys.exit(0 if all(row["same"] for row in results) else 1)
