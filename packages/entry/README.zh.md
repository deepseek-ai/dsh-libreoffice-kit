# @deepseek-ai/libreoffice-kit

[English](README.md) | 中文

使用预编译 LibreOffice 引擎，在 Node.js 中转换本地 Office、OpenDocument 文件并重算工作簿。通过同一套 API，为服务端、桌面应用和文档处理任务提供可配置字体、取消和资源限制。

二进制 `.doc`、`.xls`、`.ppt` 输入必须是 OLE 复合文档，例如 Office 97–2003 文件。不支持改后缀的 RTF/HTML 和 `.wps`。二进制输入的 `missingFonts` 为空，因为其字体表由 LibreOffice 读取，而不是由 OOXML 检查器读取。

## 安装与使用

使用 Node.js 22.19.0 或更新版本安装：

```sh
npm install @deepseek-ai/libreoffice-kit@0.0.2-rc3
```

本候选版仅发布 Node API 与 Linux WASM 引擎。npm 在 Linux 上安装 `@deepseek-ai/libreoffice-kit-wasm`。本版不支持 macOS 和 Windows；其开发运行时仍要求另行准备匹配的原生引擎，不会切换到 WASM。引擎缺失或无效时，`createConverter` 以 `unavailable` 拒绝；转换失败不会切换引擎。

```js
import { createConverter } from '@deepseek-ai/libreoffice-kit';

const converter = await createConverter({ timeoutMs: 120_000 });
try {
  const result = await converter.render({
    inputPath: '/private/work/document.docx',
    outputPath: '/private/work/document.pdf',
  });
  console.log(result.backend, result.missingFonts);
} finally {
  await converter.dispose();
}
```

WASM 引擎是仅供 Linux 使用的可选依赖。应用构建方必须确认已安装该引擎；必需引擎缺失时，`createConverter()` 以 `unavailable` 拒绝。本候选版不迁移现有 macOS/Windows 应用到 WASM。

每个转换器串行执行转换和重算。一次操作会创建独立的原生进程或 Node worker 以及私有配置目录，因此字体、文档状态和失败不会泄漏到后续渲染。截止时间在获得转换槽位之后开始计算。`AbortSignal` 可以取消排队中或进行中的工作；取消和 `dispose()` 都会等待进程或 worker 退出并完成临时文件清理。已释放的转换器会拒绝后续工作。

转换 worker 以空的 `execArgv` 运行包内发布的 JavaScript；`--input-type=module` 之类的调用方启动参数不会被继承。

在 Linux 上，原生子进程会先在所选引擎的 program 目录中查找共享库，然后才查找系统路径。调用方提供的 `LD_LIBRARY_PATH` 和 `LD_PRELOAD` 不会被继承。

调用方负责授权输入访问并拥有私有输入/输出目录；路径必须是绝对路径，并在转换期间保持不变。输入文件必须是常规 Office 文件，且在配置的字节限制之内。ZIP 条目数和解压大小限制适用于 OOXML 和 OpenDocument；二进制 DOC/XLS/PPT 使用 OLE 复合容器，内部结构由 LibreOffice 导入器验证。二进制格式仍遵守相同的转换超时和输入/输出限制。输出创建使用独占模式和 `0600` 权限；已存在的输出绝不会被覆盖。失败或取消的操作会删除新建的输出。`maxOutputBytes` 限制返回的文档及其读取缓冲区；原生临时磁盘文件在导出完成前可能继续增长，随后过大的输出会在 Node 读取之前被拒绝并删除。成功的输出归调用方所有，生命周期独立于转换器。

`ConversionError.code` 区分 `invalid-document`、`unsupported-format`、`input-too-large`、`output-too-large`、`invalid-output`、`timeout`、`unavailable` 和 `failed`。这些 code 会原样穿过 worker 和原生传输层。无效的安装资源会让创建以 `unavailable` 拒绝；它们绝不会启用回退。`EEXIST` 等文件系统错误、无效配置错误和调用方取消原因保持原样。

## 转换、重算与 CLI

`converter.convert({ inputPath, outputPath, sheet? }, signal?)` 根据输出后缀选择格式。`converter.render()` 委托同一实现生成 PDF。支持以下组合：

| 输入 | 输出 |
| --- | --- |
| DOC、DOCX、ODT | PDF、DOCX、ODT、TXT |
| XLS、XLSX、ODS | PDF、XLSX、ODS、CSV |
| PPT、PPTX、ODP | PDF、PPTX、ODP |

CSV 每次导出一个工作表，采用 UTF-8、逗号和双引号字段。单表工作簿无需选择；多表工作簿必须通过 `sheet` 指定精确的工作表名称。选择参数仅适用于 CSV。本 API 不提供 PNG 分页导出。

`converter.recalculate({ inputPath, outputPath }, signal?)` 接受 XLS、XLSX 或 ODS，并写入新的 XLSX 或 ODS。它等待引擎同步完成整本工作簿计算，再保存公式与缓存结果。输入输出必须不同，已有输出会被拒绝。重算不代表公式或业务数据验证通过；外部链接仍不加载。

`discoverRuntime()` 返回当前安装的 `{ cliPath, nodeApiPath, version, backend }`，无需启动引擎。应用可以把这些绝对路径暴露给脚本，不必发现系统 LibreOffice。已安装的 CLI 离线调用同一套 Node API：

```sh
node <cliPath> capabilities --json
node <cliPath> convert --input report.docx --output report.pdf
node <cliPath> convert --input workbook.xlsx --output summary.csv --sheet Summary
node <cliPath> recalculate --input workbook.xlsx --output workbook.checked.xlsx
```

CLI 路径相对其工作目录解析。成功向 stdout 写入一个 JSON 对象；失败向 stderr 写入带分类的 JSON 错误并以状态 1 退出。SIGINT 和 SIGTERM 取消操作并等待清理。`capabilities` 列出格式组合及适用选项。转换命令接受 `--timeout-ms`、`--max-output-bytes` 等资源限制，可重复的 `--font-directory`、`--initial-font-family`，以及 JSON 格式的 `--font-fallbacks`。所有参数均经过 API 校验。

原生与 WASM 适配层保留现有精简组件和禁用宏执行的策略。私有引擎 helper 不是通用 `soffice` 可执行文件。

## 引擎、字体与运行行为

Node API 与引擎包使用相同的 kit 发布版本。`ENGINE_VERSION` 将 WASM 和原生可选依赖固定到精确的引擎版本。npm 安装预编译引擎；安装和转换阶段均不会编译 LibreOffice 或额外下载引擎资源。每个引擎包的 `sources/` 和 `licenses/` 保留匹配的源码配方、补丁、构建信息和第三方许可声明。

默认值和所有选项记录在随包发布的 `lib/types/index.d.ts` 类型声明中。字体目录使用所选操作系统的常规系统/用户路径。索引会跳过缺失或受保护的来源，并传播其他文件系统错误。`fontkit` 索引原始字体文件并选择已安装的字面和字形覆盖；它不重写字体。转换器复用其第一次字体元数据快照；更改已安装字体后需重新创建转换器。原始字体字节和解码后的字形覆盖都只在本次转换内有效。精确的 family 匹配优先于 `fontFallbacks`。`missingFonts` 包含可读文档 XML 中声明但缺失的 family，不包含无关的引擎默认值。未命名缺失 family 的缺字并不构成完整的文档可访问性报告。

精确匹配的已安装 family 优先，包括调用方显式要求的书法或装饰字体。默认 `fontFallbacks` 优先选择常见的衬线、无衬线、等宽文本字体族以及对应的简体中文字面，为 Calibri 和 Calibri Light 使用 Carlito，为 Cambria 使用 Caladea。当匹配的字面已安装时，目录匹配保留 WASM 字体请求给出的字重和斜体。完整索引目录对首选字体族缺失的字形仍然可用。调用方提供的分组会替换默认值；`[]` 会移除这些偏好但不关闭目录发现。WASM 对导入的字体使用相同的顺序别名。随包发布的选项类型包含 `fontFallbacks` 的定义。

原生转换会把缺失 family 的选择写入其私有 LibreOffice 配置。LibreOffice 会先解析已安装的原始字体及其度量兼容字体，然后才参考这些选择，因此自定义分组在不同引擎上可能产生不同的替换结果。原生的字重和斜体选择取决于引擎及其能发现的字体；原生字体预加载只请求常规字面。

`maxFontFiles` 和 `maxFontFileBytes` 限制字体索引；`maxLoadedFontBytes` 限制本次转换中由本 kit 显式导入的原始文件。WASM 只使用导入的原始文件，找不到可用字体时以 `unavailable` 拒绝；在最小化容器中转换前请安装字体或配置 `fontDirectories`。原生 macOS 和 Windows 引擎还可以使用操作系统管理的字体，因此该导入限制不是原生字体总内存的上限。字体匹配和 XML 处理在可取消的 worker 内运行；不涉及浏览器字体 RPC 或 DOM。

Node WASM 的图像降采样使用 LibreOffice 的 CPU 图像过滤器。文本排版、字体匹配和 PDF 序列化同样由 CPU 完成。

为获得可复现的比较结果，请使用相同的文档、字体、DPI 和限制；WASM 安装在 Linux 上运行。报告时应把引擎启动时间和转换时间一起给出；每次渲染都会启动一个全新的引擎。WASM 资源和平台载荷都带有各自的源码、许可证和完整性清单。

## 源码与许可

本包使用 [MPL-2.0](LICENSE) 许可。引擎包包含 `prebuilds.json` 完整性清单、`sources/` 对应源码配方和补丁，以及 `licenses/` 第三方再分发声明。

## 使用限制

- 保真度取决于源格式、已安装字体和所选引擎。缺失字体名称不能报告所有缺字。
- 输入输出限于文档列出的格式矩阵。转换不发现系统 LibreOffice，也不下载引擎和字体。
- 字体导入和输出限制不能约束全部原生内存或临时磁盘使用。原生平台引擎的字体解析可能与 WASM 不同。
- npm 安装使用按平台选择的可选包。自行打包引擎的应用需要保留所选包的完整内容，包括资源和许可声明。
- Windows 需要系统安装与 Node.js 架构一致的 Microsoft Visual C++ v14 Redistributable（x64 或 ARM64）；包中不捆绑该运行库。Windows ARM64 引擎需要使用 ARM64 Node.js。
- `0.0.1` 提供 macOS 和 Windows 的 ARM64、x64 原生引擎和共享 Node WASM 引擎；其他原生平台仅保留开发构建配方。
