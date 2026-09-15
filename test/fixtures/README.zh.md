# Office application fixtures

[English](README.md) | 中文

`one-sheet.xlsx` 和 `one-slide.pptx` 在一个工作簿和一个幻灯片中包含文本 `Office preview 中文文档`，不含图像或外部资源。它们用于在原生和 WASM 安装检查中验证 Calc 和 Impress 的加载与 PDF 导出。它们不构成复杂文档保真度的证据。

这些 XML 部分原样来自 DeepSeek Harness 的 `apps/web/tests/office-fixture.ts` 中的 `realOfficeBytes` 函数，使用其默认字体。该源文件的 SHA-256 为 `f606419564c82b4e4d9905dc570086aeaa121e9b49a6859148adeef37392045f`；其 MIT 声明保留在仓库 [NOTICE](../../NOTICE) 中。该函数此前已通过真实的 Web 预览和已安装转换器验证。

存储的输出使用源 Web 工作区的 `fflate@0.8.3` 规范化：`zipSync(unzipSync(realOfficeBytes(extension)), { mtime: new Date(2000, 0, 1), level: 9 })`。这样在不改变任何 XML 内容的前提下固定 ZIP 时间戳。测试读取已提交的文件；它们既不需要 DeepSeek Harness 检出，也不需要生成器依赖。

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `one-sheet.xlsx` | 1429 | `2c234c8591a88a0118916d4e4e06faf5e1303d5ef1db8978eb1135deacc0b6da` |
| `one-slide.pptx` | 1689 | `e0cade001720bc43a5aa01c4043a33e83365c3b624d75a01e739d38a9db9ce5b` |

## 二进制 Office 样例

`one-page.doc`、`one-sheet.xls` 和 `one-slide.ppt` 包含相同的 `Office preview 中文文档` 文字。Word 源文件是本仓库编写的最小 OOXML 段落，表格和演示源文件为上述样例。使用独立用户配置的 LibreOffice 26.8.0.3，以 `MS Word 97`、`MS Excel 97` 和 `MS PowerPoint 97` 导出。这些已提交的 OLE 文件不包含用户文档，并通过了发布隐私扫描；用于验证旧格式导入器，不在测试期间生成。

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `one-page.doc` | 9216 | `2483a8cafde92910a0ea857cce49c07e6fa6bf58ab4a4f0852dfd2f488dedba1` |
| `one-sheet.xls` | 5632 | `311df8fcb797cfeffb552f254a054976ab61611d4a2cf68cd11f3ae7e2a73d37` |
| `one-slide.ppt` | 606720 | `1f0eb633897433cbc7cf05e7ee99f43424205dddc180aff4c58c4b18964816ce` |
