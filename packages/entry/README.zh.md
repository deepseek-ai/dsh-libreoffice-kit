---
description: "使用预编译 LibreOffice 引擎，将私有 DOCX、XLSX 和 PPTX 文件转换为 PDF。"
kind: "package-library"
---
# @deepseek-ai/dsh-libreoffice-kit

[English](README.md) | 中文

## 概述

在 Node.js 中将已授权的磁盘 DOCX、XLSX 和 PPTX 文档转换为 PDF。Host 文档渲染器使用本库进行引擎选择、取消、资源限制和字体加载。它选择已安装的原生引擎或必需的共享 WASM 引擎，不编译 LibreOffice，也不在运行时下载资源。调用方负责源文件授权，并拥有成功生成的输出文件。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制和延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

内部预览打包 macOS ARM64 和共享 WASM 引擎。这是库依赖。the host application将其组合进 Office 预览。`createConverter` 选择已安装的 OS/架构/libc 引擎；匹配原生包缺失，或已知宿主 glibc 低于其记录的最低要求时，选择 WASM。无效的已安装资源和转换失败都会拒绝请求。

```js
import { createConverter } from '@deepseek-ai/dsh-libreoffice-kit';

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

每个转换器串行执行渲染。一次渲染会创建独立的原生进程或 Node worker 以及私有配置目录，因此字体、文档状态和失败不会泄漏到后续渲染。截止时间在获得转换槽位之后开始计算。`AbortSignal` 可以取消排队中或进行中的工作；取消和 `dispose()` 都会等待进程或 worker 退出并完成临时文件清理。已释放的转换器会拒绝后续工作。

转换 worker 以空的 `execArgv` 运行包内发布的 JavaScript；`--input-type=module` 之类的调用方启动参数不会被继承。

在 Linux 上，原生子进程会先在所选引擎的 program 目录中查找共享库，然后才查找系统路径。调用方提供的 `LD_LIBRARY_PATH` 和 `LD_PRELOAD` 不会被继承。

调用方负责授权输入访问并拥有私有输入/输出目录；路径必须是绝对路径，并在转换期间保持不变。输入文件必须是常规 OOXML 文件，且在配置的 ZIP 和字节限制之内。输出创建使用独占模式和 `0600` 权限；已存在的输出绝不会被覆盖。失败或取消的渲染会删除新建的输出。`maxOutputBytes` 限制返回的 PDF 及其读取缓冲区；原生临时磁盘文件在导出完成前可能继续增长，随后过大的 PDF 会在 Node 读取之前被拒绝并删除。成功的 PDF 归调用方所有，调用方可以将其字节发送给浏览器 PDF 阅读器。

`ConversionError.code` 区分 `invalid-document`、`unsupported-format`、`input-too-large`、`output-too-large`、`invalid-output`、`timeout`、`unavailable` 和 `failed`。这些 code 会原样穿过 worker 和原生传输层。无效的安装资源会让创建以 `unavailable` 拒绝；它们绝不会启用回退。`EEXIST` 等文件系统错误、无效配置错误和调用方取消原因保持原样。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

本仓库在同一内部 Release 中发布 Node API 和引擎。`ENGINE_VERSION` 固定独立的 `@deepseek-ai/dsh-libreoffice-kit-*` 引擎版本。必需 WASM 和可选原生依赖使用 `workspace:*`；打包钩子写入固定的内部 GitHub Release URL。应用构建时鉴权下载并打包已准备的引擎；匿名 npm 安装无法获取这些依赖。[引擎工作区](../../README.zh.md)负责配方、校验和发布。

默认值和所有选项记录在 [TypeScript API](src/index.ts) 中。字体目录使用所选操作系统的常规系统/用户路径。索引会跳过缺失或受保护的来源，并传播其他文件系统错误。`fontkit` 索引原始字体文件并选择已安装的字面和字形覆盖；它不重写字体。转换器复用其第一次字体元数据快照；更改已安装字体后需重新创建转换器。原始字体字节和解码后的字形覆盖都只在本次转换内有效。精确的 family 匹配优先于 `fontFallbacks`。`missingFonts` 包含可读文档 XML 中声明但缺失的 family，不包含无关的引擎默认值。未命名缺失 family 的缺字并不构成完整的文档可访问性报告。

精确匹配的已安装 family 优先，包括调用方显式要求的书法或装饰字体。默认 `fontFallbacks` 优先选择常见的衬线、无衬线、等宽文本字体族以及对应的简体中文字面，为 Calibri 和 Calibri Light 使用 Carlito，为 Cambria 使用 Caladea。当匹配的字面已安装时，目录匹配保留 WASM 字体请求给出的字重和斜体。完整索引目录对首选字体族缺失的字形仍然可用。调用方提供的分组会替换默认值；`[]` 会移除这些偏好但不关闭目录发现。WASM 对导入的字体使用相同的顺序别名。默认分组定义在 [`src/options.ts`](src/options.ts) 中。

原生转换会把缺失 family 的选择写入其私有 LibreOffice 配置。LibreOffice 会先解析已安装的原始字体及其度量兼容字体，然后才参考这些选择，因此自定义分组在不同引擎上可能产生不同的替换结果。原生的字重和斜体选择取决于引擎及其能发现的字体；原生字体预加载只请求常规字面。

`maxFontFiles` 和 `maxFontFileBytes` 限制字体索引；`maxLoadedFontBytes` 限制本次转换中由本 kit 显式导入的原始文件。WASM 只使用导入的原始文件，找不到可用字体时以 `unavailable` 拒绝；在最小化容器中转换前请安装字体或配置 `fontDirectories`。原生 macOS 和 Windows 引擎还可以使用操作系统管理的字体，因此该导入限制不是原生字体总内存的上限。字体匹配和 XML 处理在可取消的 worker 内运行；不涉及浏览器字体 RPC 或 DOM。

Node WASM 的图像降采样使用 LibreOffice 的 CPU 图像过滤器。文本排版、字体匹配和 PDF 序列化同样由 CPU 完成。

为获得可复现的比较结果，请在两个相互独立的安装（一个带可选原生包、一个不带）中使用相同的文档、字体、DPI 和限制。报告时应把引擎启动时间和转换时间一起给出；每次渲染都会启动一个全新的引擎。必需的 WASM 资源和平台载荷都带有各自的源码、许可证和完整性清单。

不发布 runtime invariant companion，因为每次转换拥有自己的进程或 Worker 及文件，没有需要核对的独立服务状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

[打包指南](../../docs/packaging.md)定义回执和再分发声明；[发布指南](../../docs/building.md)定义源码 tag 和安装后的资格验证。

-----

<a id="model-experience"></a>
## 模型体验

无，因为磁盘转换不提供模型输入。

#### KV Cache 影响

本库不向模型请求增加 token，也不改变可复用的模型前缀。

## 已知限制和延后工作

<a id="known-limitations-and-deferred-work"></a>

- 保真度取决于源格式、已安装字体和所选引擎。缺失字体名称不能报告所有缺字。
- 只支持 DOCX、XLSX 和 PPTX 输入。转换不发现系统 LibreOffice，也不下载引擎和字体。
- 字体导入和输出限制不能约束全部原生内存或临时磁盘使用。原生平台引擎的字体解析可能与 WASM 不同。
- npm 在应用平台过滤之前下载 URL 可选依赖，因此安装时可能下载不会保留的原生归档。转换本身保持离线。
- 原生 Windows 构建配方不代表经过验收的发布；适配器清单声明已发布的原生目标。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
