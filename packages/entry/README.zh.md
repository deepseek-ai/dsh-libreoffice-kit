# @deepseek-ai/libreoffice-kit

[English](README.md) | 中文

使用预编译 LibreOffice 引擎，在 Node.js 中转换、重算并直接渲染本地 Office 文档。通过同一套 API，为服务端、桌面应用和文档处理任务提供可配置字体、取消和资源限制。

二进制 `.doc`、`.xls`、`.ppt` 输入必须是 OLE 复合文档，例如 Office 97–2003 文件。不支持改后缀的 RTF/HTML 和 `.wps`。二进制输入的 `missingFonts` 为空，因为其字体表由 LibreOffice 读取，而不是由 OOXML 检查器读取。

## 安装与使用

使用 Node.js 22.19.0 或更新版本安装：

```sh
npm install @deepseek-ai/libreoffice-kit@0.0.4
```

npm 在 macOS/Windows ARM64 或 x64 上安装匹配的原生引擎，在 Linux 上安装共享 WASM 引擎。macOS 和 Windows 必须具有对应原生包；包缺失或无效时，`createConverter` 以 `unavailable` 拒绝，不会切换到 WASM。Linux 使用 WASM，除非显式安装了兼容的原生开发包。转换失败不会切换引擎。

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

原生与 WASM 引擎是按平台筛选的可选依赖。应用构建方必须验证所需引擎已安装：macOS/Windows 使用原生引擎，Linux 使用 WASM。必需引擎缺失时，`createConverter()` 以 `unavailable` 拒绝。

每个转换器串行执行渲染。一次渲染会创建独立的原生进程或 Node worker 以及私有配置目录，因此字体、文档状态和失败不会泄漏到后续渲染。截止时间在获得转换槽位之后开始计算。`AbortSignal` 可以取消排队中或进行中的工作；取消和 `dispose()` 都会等待进程或 worker 退出并完成临时文件清理。已释放的转换器会拒绝后续工作。

通过兼容 API `createConverter(options)` 创建的转换器，会自动与进程内使用相同引擎及字体配置的其他转换器共享有界字体元数据和匹配结果。释放 converter 仍只等待它自己的工作；元数据会留给后续兼容 converter，最多保留 16 种配置。`maxFontMetadataCacheBytes` 限制保留的逐文件元数据，`maxFontResolutionEntries` 限制匹配条目，默认值为 4096。

长驻服务如果需要为多个并发转换槽提供一个显式生命周期所有者，可创建 `createConverterFactory(options)`，再通过 `factory.create()` 建立转换器。这些转换器使用 factory 私有缓存，同时仍分别拥有 Worker、原生 helper、配置目录和输出。释放 factory 会停止并等待它创建的全部转换器。

`convert()` 按输出后缀导出格式，`recalculate()` 在保存前刷新电子表格公式结果，`renderImages()` 在全新目录中写入 PNG tile 和 `manifest.json`。Office 图像直接从一次加载的模型绘制，PDF 使用 PDFium。CLI 通过 `libreoffice-kit capabilities|convert|recalculate|render` 提供相同行为。

转换 worker 以空的 `execArgv` 运行包内发布的 JavaScript；`--input-type=module` 之类的调用方启动参数不会被继承。

在 Linux 上，原生子进程会先在所选引擎的 program 目录中查找共享库，然后才查找系统路径。调用方提供的 `LD_LIBRARY_PATH` 和 `LD_PRELOAD` 不会被继承。

调用方负责授权输入访问并拥有私有输入/输出目录；路径必须是绝对路径，并在转换期间保持不变。输入文件必须是常规 Office 文件，且在配置的字节限制之内。ZIP 条目数和解压大小限制适用于 OOXML；二进制 DOC/XLS/PPT 使用 OLE 复合容器，内部结构由 LibreOffice 导入器验证。二进制格式仍遵守相同的转换超时和输入/输出限制。输出创建使用独占模式和 `0600` 权限；已存在的输出绝不会被覆盖。失败或取消的渲染会删除新建的输出。`maxOutputBytes` 限制返回的 PDF 及其读取缓冲区；原生临时磁盘文件在导出完成前可能继续增长，随后过大的 PDF 会在 Node 读取之前被拒绝并删除。成功的 PDF 归调用方所有，调用方可以将其字节发送给浏览器 PDF 阅读器。

`ConversionError.code` 区分 `invalid-document`、`unsupported-format`、`input-too-large`、`output-too-large`、`invalid-output`、`timeout`、`unavailable` 和 `failed`。这些 code 会原样穿过 worker 和原生传输层。无效的安装资源会让创建以 `unavailable` 拒绝；它们绝不会启用回退。`EEXIST` 等文件系统错误、无效配置错误和调用方取消原因保持原样。

## 引擎、字体与运行行为

Node API 与引擎包使用相同的 kit 发布版本。`ENGINE_VERSION` 将 WASM 和原生可选依赖固定到精确的引擎版本。npm 安装预编译引擎；安装和转换阶段均不会编译 LibreOffice 或额外下载引擎资源。每个引擎包的 `sources/` 和 `licenses/` 保留匹配的源码配方、补丁、构建信息和第三方许可声明。

默认值和所有选项记录在随包发布的 `lib/types/index.d.ts` 类型声明中。字体目录使用所选操作系统的常规系统/用户路径。索引会跳过缺失或受保护的来源，并传播其他文件系统错误。`fontkit` 索引原始字体文件并选择已安装的字面和字形覆盖；它不重写字体。每次操作都会重新发现字体候选并验证缓存中的文件身份。一次操作使用一份有序元数据快照；快照变化后字体匹配条目失效。检测到转换期间字体变化时，操作会失败并删除其输出。原始字体字节和解码后的字形覆盖都只在本次转换内有效。精确的 family 匹配优先于 `fontFallbacks`。`missingFonts` 包含可读文档 XML 中声明但缺失的 family，不包含无关的引擎默认值。未命名缺失 family 的缺字并不构成完整的文档可访问性报告。

### 字体元数据缓存

`createConverter()` 和 `createConverterFactory()` 均接受：

| 选项 | 默认值 | 行为 |
| --- | --- | --- |
| `fontMetadataCacheDirectory` | 用户系统缓存目录 | 目录的绝对路径，或用 `false` 关闭磁盘缓存。 |
| `maxFontMetadataCacheBytes` | 32 MiB | 正安全整数，限制单个缓存文件的读取、写入及每份共享配置保留的逐文件元数据。 |

macOS 默认使用 `~/Library/Caches/libreoffice-kit`，Windows 使用 `%LOCALAPPDATA%/libreoffice-kit/Cache`（缺省时回退到用户的 `AppData/Local`），Linux 使用 `$XDG_CACHE_HOME/libreoffice-kit`（缺省时回退到 `~/.cache`）。单个 `font-metadata.json` 文件保存规范文件路径、设备/inode、大小、修改/变更时间及全部 face 元数据，包括解析结果为空的记录。它不保存字体字节、字形覆盖、解析对象、文档文本或文档匹配条目。请将此用户级文件保持私有。

没有可复用元数据的首次运行仍执行原来的完整字体 inspect。后续进程只跳过已发现且文件身份完全匹配的字体。每次操作重新枚举来源，包括 Office 补充字体，因此新增、删除、替换和目录变化无需重启。候选顺序、文件预算、Office 过滤、fallback 匹配、字形查询和原字体导入保持原有行为。缓存损坏、版本不兼容、超限或不可访问时回退到字体源计算；不可读的源字体不会复用旧记录。缓存格式、提取逻辑和固定的 fontkit 版本均须匹配。

新建缓存目录和文件使用私有权限（平台支持时为 `0700`/`0600`）。写入先在同目录独占创建临时文件，关闭后原子替换。未变化的快照不重写；超过字节上限的快照不保留、不写入。独立进程可以竞争发布完整快照，只影响命中率。元数据 Worker 退出后，所属操作清理自己创建的临时文件。

同一共享配置内同时开始的操作共享短生命周期元数据 Worker。每个等待者保留自己的取消和截止时间；取消一个不会取消其他等待者。最后一个等待者退出时终止并等待 Worker。扫描完成后只保留有界元数据，不保留扫描 Worker 或原始字体 Buffer。`fontMetadataCacheDirectory: false` 仍保留进程内共享与源字体版本检查。factory 缓存有独立生命周期，由 `factory.dispose()` 清理。

macOS 或 Windows 上省略 `fontDirectories` 时，默认发现还会检查 Microsoft Office 的捆绑/私有字体目录和用户 Office 字体缓存。只补充常规系统目录中不存在的精选 Office 兼容字体族，包括宋体和微软雅黑。显式 `fontDirectories` 会关闭这项补充发现。

精确匹配的已安装 family 优先，包括调用方显式要求的书法或装饰字体。默认 `fontFallbacks` 优先选择常见的衬线、无衬线、等宽文本字体族以及对应的简体中文字面，为 Calibri 和 Calibri Light 使用 Carlito，为 Cambria 使用 Caladea。当匹配的字面已安装时，目录匹配保留 WASM 字体请求给出的字重和斜体。完整索引目录对首选字体族缺失的字形仍然可用。调用方提供的分组会替换默认值；`[]` 会移除这些偏好但不关闭目录发现。WASM 对导入的字体使用相同的顺序别名。随包发布的选项类型包含 `fontFallbacks` 的定义。

原生转换会把缺失 family 的选择写入其私有 LibreOffice 配置。LibreOffice 会先解析已安装的原始字体及其度量兼容字体，然后才参考这些选择，因此自定义分组在不同引擎上可能产生不同的替换结果。原生的字重和斜体选择取决于引擎及其能发现的字体；原生字体预加载只请求常规字面。

`maxFontFiles` 和 `maxFontFileBytes` 限制字体索引；`maxLoadedFontBytes` 限制本次转换中由本 kit 显式导入的原始文件。WASM 只使用导入的原始文件，找不到可用字体时以 `unavailable` 拒绝；在最小化容器中转换前请安装字体或配置 `fontDirectories`。原生 macOS 和 Windows 引擎还可以使用操作系统管理的字体，因此该导入限制不是原生字体总内存的上限。字体匹配和 XML 处理在可取消的 worker 内运行；不涉及浏览器字体 RPC 或 DOM。

Node WASM 的图像降采样使用 LibreOffice 的 CPU 图像过滤器。文本排版、字体匹配和 PDF 序列化同样由 CPU 完成。

为获得可复现的比较结果，请使用相同的文档、字体、DPI 和限制；WASM 安装在 Linux 上运行。报告时应把引擎启动时间和转换时间一起给出；每次渲染都会启动一个全新的引擎。WASM 资源和平台载荷都带有各自的源码、许可证和完整性清单。

## 源码与许可

本包使用 [MPL-2.0](LICENSE) 许可。引擎包包含 `prebuilds.json` 完整性清单、`sources/` 对应源码配方和补丁，以及 `licenses/` 第三方再分发声明。

## 使用限制

- 保真度取决于源格式、已安装字体和所选引擎。缺失字体名称不能报告所有缺字。
- 支持 DOC/DOCX/ODT、XLS/XLSX/ODS 和 PPT/PPTX/ODP 转换；直接图像渲染还接受 PDF。转换不发现系统 LibreOffice，也不下载引擎和字体。
- 字体导入和输出限制不能约束全部原生内存或临时磁盘使用。原生平台引擎的字体解析可能与 WASM 不同。
- npm 安装使用按平台选择的可选包。自行打包引擎的应用需要保留所选包的完整内容，包括资源和许可声明。
- Windows 需要系统安装与 Node.js 架构一致的 Microsoft Visual C++ v14 Redistributable（x64 或 ARM64）；包中不捆绑该运行库。Windows ARM64 引擎需要使用 ARM64 Node.js。
- `0.0.4` 提供 macOS 和 Windows 的 ARM64、x64 原生引擎，以及供 Linux 使用的共享 Node WASM 引擎；其他原生平台仅保留开发构建配方。
