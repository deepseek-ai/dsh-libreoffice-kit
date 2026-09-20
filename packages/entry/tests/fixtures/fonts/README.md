# Font subset fixtures

These small fixtures come from HarfBuzz commit `36cb489cb02ce4b92099669ba9f9bea348eff93f`, under `test/subset/data/fonts/` in [the pinned source](https://github.com/harfbuzz/harfbuzz/tree/36cb489cb02ce4b92099669ba9f9bea348eff93f/test/subset/data/fonts). Copyright and license records remain embedded in each font.

| Fixture | Upstream file | Retained text/scalars | License |
| --- | --- | --- | --- |
| LatinGreek.ttf | Roboto-Regular.ttf | ` ABabcfiΩЖ` | Apache-2.0; Copyright 2011 Google Inc. |
| Arabic.ttf | NotoNastaliqUrdu-Regular.ttf | ` سلامعليكم` | OFL-1.1; Copyright 2017–2022 Google Inc. |
| Devanagari.ttf | NotoSansDevanagari-Regular.ttf | ` नमस्तेक्षि` | OFL-1.1; Copyright 2015 Google Inc. |
| Newa.ttf | NotoSansNewa-Regular.ttf | U+0020, U+11400, U+11401 | OFL-1.1; Copyright 2018 Google Inc. |
| Variable.ttf | NotoSans-VF.abc.ttf | Unmodified upstream fixture | OFL-1.1; Copyright 2015–2021 Google LLC. |

The first four files were produced with HarfBuzz `hb-subset` 14.4.0, using the listed text (`--text`) or scalars (`--unicodes`) and `--layout-features=* --name-IDs=* --name-languages=* --notdef-outline`. `Faces.ttc` contains LatinGreek and Devanagari as two physical faces. `Face.dfont` wraps LatinGreek in a single classic `sfnt` resource. [containers.py](containers.py) regenerates these containers with fontTools 4.60.0 without changing font timestamps. These are test data, not application fonts.
