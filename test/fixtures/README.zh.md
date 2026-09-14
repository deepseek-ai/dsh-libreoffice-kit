# Office application fixtures

[English](README.md) | 中文

`one-sheet.xlsx` 和 `one-slide.pptx` 在一个工作簿和一个幻灯片中包含文本 `Office preview 中文文档`，不含图像或外部资源。它们用于在原生和 WASM 安装检查中验证 Calc 和 Impress 的加载与 PDF 导出。它们不构成复杂文档保真度的证据。

这些 XML 部分原样来自 DeepSeek Harness 的 `apps/web/tests/office-fixture.ts` 中的 `realOfficeBytes` 函数，使用其默认字体。该源文件的 SHA-256 为 `f606419564c82b4e4d9905dc570086aeaa121e9b49a6859148adeef37392045f`；其 MIT 声明保留在仓库 [NOTICE](../../NOTICE) 中。该函数此前已通过真实的 Web 预览和已安装转换器验证。

存储的输出使用源 Web 工作区的 `fflate@0.8.3` 规范化：`zipSync(unzipSync(realOfficeBytes(extension)), { mtime: new Date(2000, 0, 1), level: 9 })`。这样在不改变任何 XML 内容的前提下固定 ZIP 时间戳。测试读取已提交的文件；它们既不需要 DeepSeek Harness 检出，也不需要生成器依赖。

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `one-sheet.xlsx` | 1429 | `2c234c8591a88a0118916d4e4e06faf5e1303d5ef1db8978eb1135deacc0b6da` |
| `one-slide.pptx` | 1689 | `e0cade001720bc43a5aa01c4043a33e83365c3b624d75a01e739d38a9db9ce5b` |
