# Office application fixtures

English | [中文](README.zh.md)

`one-sheet.xlsx` and `one-slide.pptx` contain the text `Office preview 中文文档` in one worksheet and one slide, without images or external resources. They exercise Calc and Impress loading and PDF export in native and WASM installation checks. They do not establish complex-document fidelity.

The XML parts come unchanged from DeepSeek Harness's `apps/web/tests/office-fixture.ts`, function `realOfficeBytes`, using its default font. That source file's SHA-256 is `f606419564c82b4e4d9905dc570086aeaa121e9b49a6859148adeef37392045f`; its MIT notice is retained in the repository [NOTICE](../../NOTICE). The function was already exercised through the real Web preview and installed converter.

The stored outputs were normalized with the source Web workspace's `fflate@0.8.3`: `zipSync(unzipSync(realOfficeBytes(extension)), { mtime: new Date(2000, 0, 1), level: 9 })`. This fixes ZIP timestamps without changing any XML content. Tests read the committed files; they require neither the DeepSeek Harness checkout nor a generator dependency.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `one-sheet.xlsx` | 1429 | `2c234c8591a88a0118916d4e4e06faf5e1303d5ef1db8978eb1135deacc0b6da` |
| `one-slide.pptx` | 1689 | `e0cade001720bc43a5aa01c4043a33e83365c3b624d75a01e739d38a9db9ce5b` |

## Binary Office fixtures

`one-page.doc`, `one-sheet.xls`, and `one-slide.ppt` contain the same `Office preview 中文文档` text. The Word source is a minimal, repository-authored OOXML paragraph; the spreadsheet and presentation sources are the fixtures above. LibreOffice 26.8.0.3 exported them using `MS Word 97`, `MS Excel 97`, and `MS PowerPoint 97` with an isolated user profile. These committed OLE files contain no user documents and passed the publication privacy scanner. They qualify the legacy import filters; they are not generated during tests.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `one-page.doc` | 9216 | `2483a8cafde92910a0ea857cce49c07e6fa6bf58ab4a4f0852dfd2f488dedba1` |
| `one-sheet.xls` | 5632 | `311df8fcb797cfeffb552f254a054976ab61611d4a2cf68cd11f3ae7e2a73d37` |
| `one-slide.ppt` | 606720 | `1f0eb633897433cbc7cf05e7ee99f43424205dddc180aff4c58c4b18964816ce` |
