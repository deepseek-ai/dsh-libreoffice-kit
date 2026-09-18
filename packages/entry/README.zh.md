# @deepseek-ai/libreoffice-kit

Node API、CLI、浏览器适配器和字体服务复用本包；精确版本依赖 `@deepseek-ai/libreoffice-kit-wasm` 提供跨平台预编译引擎。不在安装或文档操作期间编译、下载引擎或发现系统 LibreOffice。需要 Node.js 22.19 以上。

## 直接输出图片

```ts
import { createConverter } from '@deepseek-ai/libreoffice-kit'
const converter = await createConverter({ timeoutMs: 120_000 })
try {
  await converter.renderImages({ inputPath: '/private/report.docx', outputDir: '/private/new-images', pages: [1, 3], dpi: 144 })
  await converter.renderImages({ inputPath: '/private/book.xlsx', outputDir: '/private/new-sheet', sheet: '汇总', range: 'A1:D20' })
} finally { await converter.dispose() }
```

`renderImages` 从一次已保存文件快照加载模型，在新目录中输出 `page-0001.png` 等图片和 `manifest.json`。支持 DOC/DOCX/ODT、XLS/XLSX/ODS、PPT/PPTX/ODP 以及 PDF。Office 从内存模型直接绘图，不经过 PDF；PDF 使用独立 PDFium 路径。原 `render({inputPath,outputPath})` 仍保持导出 PDF 的兼容语义。

- Word、PPT 和 PDF 的 `pages` 是从 1 开始的实体页/幻灯片序号；默认全部，数组保留请求顺序。
- Excel 使用精确 `sheet` 名称与可选 A1 `range`，范围必须指定工作表。不传选择器时渲染全部可见表的数据区，拒绝打印页码。隐藏/筛选行列保留显示行为。默认数据区不包含仅有格式的单元格或独立绘图对象，可显式指定更大范围；空表渲染 A1。
- `dpi` 默认 144，范围 24–600；`maxPages` 默认 100；每图 `maxPixels` 默认且最多 16,777,216。超限明确报错，不截断批次。大表使用较小范围或 DPI。
- 输入、全部 PNG 字节总量、字体和超时受 `ConverterOptions` 限制。完整选项与默认值见随包 TypeScript 声明。
- 清单包含 `source:'saved'`、原输入路径与 SHA256、`backend:'wasm'`、实际 `rasterEngine`、总页数、已选图片及尺寸、96 DPI 下源矩形。Excel 总页数表示可见工作表数，图片使用 `sheet`/`range` 而非 `page`。

调用方负责授权绝对路径并保护私有目录免受并发路径替换。输入必须是非空普通文件，输出目录必须不存在。失败、取消、超时或 dispose 会等待 Worker 退出并清理整个新批次，不删除已有目录。转换器串行执行调用；每次操作使用新 Worker，浏览器编辑复用另行保留的会话。

## CLI 与转换

```sh
libreoffice-kit capabilities --json
libreoffice-kit render --input report.docx --output-dir new-images --pages 1,3 --dpi 144
libreoffice-kit render --input book.xlsx --output-dir new-sheet --sheet '汇总' --range A1:D20
libreoffice-kit render --input document.pdf --output-dir new-pdf-images
libreoffice-kit convert --input book.xlsx --output table.csv --sheet '汇总'
libreoffice-kit recalculate --input book.xlsx --output checked.xlsx
```

CLI 相对路径按工作目录解析，成功在 stdout 输出一个 JSON，失败在 stderr 输出 `{code,error}` 并退出 1。SIGINT/SIGTERM 取消后等待清理。`render` 支持 `--max-pages`、`--max-pixels`，以及通用输入/输出/归档/字体限制、`--timeout-ms`、可重复字体目录和初始 family，以及 JSON `--font-fallbacks`。

`convert` 保留 Writer → PDF/DOCX/ODT/TXT、Calc → PDF/XLSX/ODS/CSV、Impress → PDF/PPTX/ODP。多表 CSV 必须指定精确表名，输出 UTF-8 逗号分隔文件。`recalculate` 对 XLS/XLSX/ODS 同步重算并保存 XLSX/ODS 的公式和缓存结果，不验证业务逻辑。输出必须是新文件，宏和外部链接更新保持禁用。

## 字体与 PDF 范围

Node 端在限制范围内发现系统字体，精确 family 优先于回退配置，导入完整原始字体。安装字体改变后重新创建转换器。`missingFonts` 只报告可读 OOXML 的声明 family，不代表全部缺字或 PDF 字体诊断。

`@deepseek-ai/libreoffice-kit/fonts` 的 `createFontSource` 是独立懒加载字体 Worker。默认 `resolve(attributes)` 保留 Office 的 Unicode-script 子集；新增 `resolve({...attributes,mode:'full'})` 返回不暴露主机路径的 `full_…` ID、原 family 和 ttf/otf/ttc 格式。`read(id)` 返回完整原字节，dfont 提取完整单字体 sfnt。来源变化或未知 ID 会拒绝读取。

PDFium 直接图片渲染仍为实验能力，与 PDF.js 和 Office 编辑模型分开。嵌入字体由 PDFium 管理；在首次字体枚举前，按初始 family 和回退组预载有字节上限的完整常规字体。该方案不自动推断所有 PDF 字体，也不修复任意自定义编码。加密 PDF 暂拒绝；上游包装层绘制表单，普通注释和高级 PDF 特性仍需专项验收。

## 浏览器支持模块

`@deepseek-ai/libreoffice-kit/font-config` 导出两个 WASM 适配器共用的浏览器安全函数 `normalize`、`fontFamilyPriority` 和 `memoryFontConfig`。`@deepseek-ai/libreoffice-kit/document-inspection` 导出 `inspectDocument(bytes, extension, limits)`，提供相同的 OOXML 限额检查和传统复合文件检查。这些子路径不会初始化引擎或读取 Host 文件系统，可由打包器纳入浏览器 Worker。独立的 `@deepseek-ai/libreoffice-kit-browser` 包负责浏览器文档渲染和不区分操作系统的引擎资源。

若依赖树无需 LibreOffice 引擎包，请使用 [`@deepseek-ai/libreoffice-kit-fonts`](../fonts/README.zh.md)；它暂存同一份实现，并从包根导出 `createFontSource`。

`@deepseek-ai/libreoffice-kit/fonts` 导出 `createFontSource(options)`，在无需安装 LibreOffice 引擎的情况下为浏览器提供 Host 字体。其惰性 Node Worker 每次匹配都会刷新已安装字体元数据，按共用回退偏好选择物理字面，并返回可复用 sfnt 子集。`resolve(request)` 返回 `{ id, bytes, family, alias }` 条目；`read(id)` 返回其字节。原始 family/style 和名称表保持不变；浏览器用内容派生的 `DSH_<SHA256>` 别名区分子集。原始文件变化后，旧读取会拒绝，需要重新匹配。取消会在已派发工作完成后丢弃结果；`dispose()` 终止 Worker 并等待其退出。

子集使用完整的 Unicode 17 Script/Script_Extensions 数据，包括补充平面和未知／私用区字符。每个文字系统保留 Common/Inherited 字符、变体选择符及 HarfBuzz 排版／复合字形闭包。空字符请求返回 Common 子集，可能仅含元数据和 `.notdef`。TTC/OTC 字体集合和 Apple dfont 资源被提取为单独的 sfnt 字面。`maxCachedSubsetBytes` 限制 Worker 内的子集字节 LRU（默认 128 MiB）；淘汰条目可从未改变的原始文件重新生成。该字体源没有磁盘缓存，保留字节限制也不是 Worker 总内存上限。

字体源需要随包发布的 HarfBuzz 子集 WASM、回执及许可声明。[构建配方](../../engine/font-subset/README.zh.md) 固定其源码，并为大文字系统分区启用堆增长；Node API 打包时验证这些资源。该字体源和测试不会改变 Node 转换器使用原始字体的行为。

## 源码与许可

使用 [MPL-2.0](LICENSE)。引擎包含 `prebuilds.json` 完整性清单、`sources/` 中的固定源码与补丁配方、`licenses/` 第三方声明；字体子集器也包含自己的配方和声明。打包应用需保留这些资源。声明目标和源码测试不能代替可安装产物的真实文档验收。
