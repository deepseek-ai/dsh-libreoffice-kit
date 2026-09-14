# Office application fixtures

English | [中文](README.zh.md)

`one-sheet.xlsx` and `one-slide.pptx` contain the text `Office preview 中文文档` in one worksheet and one slide, without images or external resources. They exercise Calc and Impress loading and PDF export in native and WASM installation checks. They do not establish complex-document fidelity.

The XML parts come unchanged from DeepSeek Harness's `apps/web/tests/office-fixture.ts`, function `realOfficeBytes`, using its default font. That source file's SHA-256 is `f606419564c82b4e4d9905dc570086aeaa121e9b49a6859148adeef37392045f`; its MIT notice is retained in the repository [NOTICE](../../NOTICE). The function was already exercised through the real Web preview and installed converter.

The stored outputs were normalized with the source Web workspace's `fflate@0.8.3`: `zipSync(unzipSync(realOfficeBytes(extension)), { mtime: new Date(2000, 0, 1), level: 9 })`. This fixes ZIP timestamps without changing any XML content. Tests read the committed files; they require neither the DeepSeek Harness checkout nor a generator dependency.

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `one-sheet.xlsx` | 1429 | `2c234c8591a88a0118916d4e4e06faf5e1303d5ef1db8978eb1135deacc0b6da` |
| `one-slide.pptx` | 1689 | `e0cade001720bc43a5aa01c4043a33e83365c3b624d75a01e739d38a9db9ce5b` |
