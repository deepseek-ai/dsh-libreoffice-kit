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
- `dpi` 默认 144，范围 24–600；每图 `maxPixels` 默认且最多 16,777,216，`maxDimension` 默认每边 8192 像素。大表区域按输出像素网格、从上到下逐行拆图；每片保留原请求 `sheet`/`range`，`rectangle` 标明该片的准确源区域。Word、PPT、PDF 保持完整页面，单页超限时报错。
- `maxPages` 默认 100，限制全部工作表拆片后的输出图片总数。绘图前检查完整批次，超限明确报错，不截断批次。
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

CLI 相对路径按工作目录解析，成功在 stdout 输出一个 JSON，失败在 stderr 输出 `{code,error}` 并退出 1。SIGINT/SIGTERM 取消后等待清理。`render` 支持 `--max-pages`、`--max-pixels`、`--max-dimension`，以及通用输入/输出/归档/字体限制、`--timeout-ms`、可重复字体目录和初始 family，以及 JSON `--font-fallbacks`。

`convert` 保留 Writer → PDF/DOCX/ODT/TXT、Calc → PDF/XLSX/ODS/CSV、Impress → PDF/PPTX/ODP。多表 CSV 必须指定精确表名，输出 UTF-8 逗号分隔文件。`recalculate` 对 XLS/XLSX/ODS 同步重算并保存 XLSX/ODS 的公式和缓存结果，不验证业务逻辑。输出必须是新文件，宏和外部链接更新保持禁用。

## 字体与 PDF 范围

Node 和 Host 字体服务共用有界系统字体发现与匹配：原字体和显式配置的替代字体优先，其次是对应 Unicode 文字系统、地区及正文类别的候选，最后选择其他覆盖所需字符的字体。Windows 顺序来自固定版本 Chromium，macOS/Linux 使用 Fontconfig 类别顺序，并补充另一来源的候选。Unicode 17 Script/Script_Extensions 数据识别混合文字，不让错误文档语言影响韩文等文字的选择。仅对未明确指定的 Latin/CJK 装饰字体降权，乌尔都文 Nastaliq 等正文传统不受影响。规则不下载或打包字体，仍导入原始字体以保留塑形和编码。兼容的 `createConverter()` 调用会自动共享进程内字体元数据和有界匹配结果；`maxFontResolutionEntries` 默认为 4096，最多保留 16 组不同字体配置。安装字体改变后需重启进程。`missingFonts` 报告缺失的声明字体，字体服务的 `unresolvedCodePoints` 单独报告没有任何已安装字体覆盖的字符。使用 `node scripts/generate-font-preferences.mjs` 更新固定来源数据，许可证保留在 `NOTICE`。

`@deepseek-ai/libreoffice-kit/fonts` 的 `createFontSource` 是独立懒加载字体 Worker。默认 `resolve(attributes)` 保留 Office 的 Unicode-script 子集；新增 `resolve({...attributes,mode:'full'})` 返回不暴露主机路径的 `full_…` ID、原 family 和 ttf/otf/ttc 格式。`read(id)` 返回完整原字节，dfont 提取完整单字体 sfnt。来源变化或未知 ID 会拒绝读取。

PDFium 直接图片渲染仍为实验能力，与 PDF.js 和 Office 阅读会话分开。嵌入字体由 PDFium 管理；在首次字体枚举前，按初始 family 和回退组预载有字节上限的完整常规字体。该方案不自动推断所有 PDF 字体，也不修复任意自定义编码。加密 PDF 暂拒绝；上游包装层绘制表单，普通注释和高级 PDF 特性仍需专项验收。

## 浏览器与字体入口

`@deepseek-ai/libreoffice-kit/browser` 通过 `openOfficeDocument` 提供常驻 Office 阅读会话、Writer 分页/连续重排、选择复制和独立 PDFium 查看。rc5 浏览器 API 不提供编辑、OOXML 保存快照或 capture；Node/CLI 的转换和重算仍保留显式输出能力。Node 端 `./browser-assets` 校验并解析主包中的 Worker，以及精确版本 WASM 依赖中的资源。Host 将其映射成资源 URL；主包不复制 LibreOffice 大文件。

`./fonts` 提供上文的字体服务。`./font-config` 与 `./document-inspection` 为浏览器和 Node 共用的纯逻辑；`./internal/*` 仅用于内部实现。字体子集采用 Unicode 17 数据和 HarfBuzz 布局闭包，内存缓存淘汰后从未变化的原字体重新生成。

## 源码与许可

使用 [MPL-2.0](LICENSE)。引擎包含 `prebuilds.json` 完整性清单、`sources/` 中的固定源码与补丁配方、`licenses/` 第三方声明；字体子集器也包含自己的配方和声明。打包应用需保留这些资源。声明目标和源码测试不能代替可安装产物的真实文档验收。
