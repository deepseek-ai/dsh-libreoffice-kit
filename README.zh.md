---
description: "使用预编译 LibreOffice 引擎，在 Node.js 中实现字体友好的 Office → PDF 转换。"
kind: "package-library"
---
# @deepseek-ai/libreoffice-kit

[English](README.md) | 中文

## 当前目标

**在 Node.js 中实现字体友好的 Office 转换与渲染。** `0.0.3` 在稳定的 `0.0.1` 系列上增加格式转换、工作簿重算、CLI、直接 PNG 渲染和共享 converter factory 字体缓存，同时保留原生引擎包。

当前优先保证文档排版和文字可读，让调用方能明确控制可用字体与替换策略，并让应用可以打包引擎、离线运行。精简也服务于这个目标：保留文档导入、排版、绘图和 PDF 导出所需的能力，移除与转换无关的桌面功能和资源。

API 支持 Office 导出与重算，以及 Office/PDF 输入的直接 PNG 渲染，可用于 Node.js 服务、桌面应用和文档处理任务。应用自行管理授权、存储和预览界面。

二进制 `.doc`、`.xls`、`.ppt` 支持 Office 97–2003 等 OLE 复合文档，不接受改成这些后缀的 RTF/HTML 文件或 `.wps`。`missingFonts` 仅报告 OOXML 中识别到的字体声明；二进制格式返回空列表，字体匹配由 LibreOffice 完成。

## 快速开始

需要 **Node.js 22.19.0 或更新版本**。安装 `0.0.3` 及其可选引擎依赖：

```sh
npm install @deepseek-ai/libreoffice-kit@0.0.3
```

```js
import { createConverter } from '@deepseek-ai/libreoffice-kit';

const converter = await createConverter({
  timeoutMs: 120_000,
  // 不设置时，从常规系统和用户目录发现字体。
  // fontDirectories: ['/absolute/path/to/fonts'],
});
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

路径必须是绝对路径，目录由调用方私有管理，输出文件必须尚不存在。PDF 写入 `outputPath`，`render` 返回所选引擎和缺失字体名称。每次转换使用独立的原生进程或 Node Worker 及私有配置；同一转换器串行执行，取消和释放会等待引擎退出与清理完成。取消、错误和资源限制见 [Node API](packages/entry/README.zh.md)。

## 0.0.3 的“字体友好”具体指什么

- **使用环境中可用的字体。** 默认发现常规系统和用户字体目录，也可通过 `fontDirectories` 指定扫描目录；自定义目录会替换默认列表。`fontkit` 读取字体元数据和字形覆盖，将选中的原始字体文件交给引擎。
- **优先保留文档指定的字体。** 已安装的同名字体族优先，包括书法和装饰字体。WASM 字体请求还携带字重、斜体信息，以便选择已安装的对应字面；缺字时可以继续从字体目录中选择补充字体。
- **允许配置替换顺序。** 默认 `fontFallbacks` 覆盖常见西文和简体中文字体，例如 Calibri 缺失时选择 Carlito、Cambria 缺失时选择 Caladea。调用方传入的分组会替换默认值。这些规则只选择可用字体，不会安装字体；具体见[默认分组](packages/entry/src/options.ts)。
- **提供缺失字体诊断和资源预算。** `missingFonts` 报告可读文档 XML 中声明但不可用的字体族；`maxFontFiles`、`maxFontFileBytes` 和 `maxLoadedFontBytes` 限制索引及显式导入。每次操作重新发现并验证字体，未变化文件的元数据通过进程内共享和有界用户级磁盘缓存复用；见[缓存选项与失效规则](packages/entry/README.zh.md#字体元数据缓存)。

引擎不捆绑或下载字体集合。部署方根据文档需求和再分发权限提供字体；最小化容器需要安装字体或指定字体目录。WASM 仅使用导入的字体，没有可用字体时以 `unavailable` 拒绝转换。macOS 和 Windows 原生引擎还可使用操作系统管理的字体。

这些能力让字体选择更可控，但不保证与 Microsoft Office 或另一引擎的输出完全一致。原生 LibreOffice 会先解析已安装的原始字体和度量兼容字体，再参考配置的替换项，并自行选择字面。字体度量差异仍可能改变换行和分页；`missingFonts` 也不是完整的缺字报告。比较引擎效果时，需要使用相同的文档字节、字体和导出选项。

## 引擎与分发

[Node 包清单](packages/entry/package.json)为 `0.0.3` 声明了以下引擎：

| 引擎 | 用途 |
| --- | --- |
| `@deepseek-ai/libreoffice-kit-darwin-arm64` | Apple Silicon macOS 的原生 helper。 |
| `@deepseek-ai/libreoffice-kit-darwin-x64` | Intel macOS 的原生 helper。 |
| `@deepseek-ai/libreoffice-kit-win32-arm64` | Windows ARM64 原生 helper；需要 ARM64 Node.js 和 Microsoft Visual C++ v14 ARM64 Redistributable。 |
| `@deepseek-ai/libreoffice-kit-win32-x64` | Windows x64 原生 helper；需要 Microsoft Visual C++ v14 x64 Redistributable。 |
| `@deepseek-ai/libreoffice-kit-wasm` | 供 Linux 使用的共享 Node WASM 引擎。 |

其他原生目录保留为开发构建配方，不代表额外的已发布目标。共享 WASM 包的 npm OS 限制为 Linux，不限制 CPU 或 libc；这项声明本身不代表每个 Linux 宿主都已验证。原生与 WASM 引擎的排版和 PDF 序列化均由 CPU 完成。

npm 在 macOS/Windows ARM64 或 x64 上仅安装匹配的原生包，在 Linux 上安装 WASM。macOS 和 Windows 必须具有对应原生包，绝不回退到 WASM。Linux 使用 WASM，除非显式安装的原生开发包支持其 glibc 版本。必需引擎缺失或已安装引擎损坏时，`createConverter` 以 `unavailable` 拒绝；转换失败不会切换引擎。

Node API 与引擎共享 kit 版本。安装使用预先构建的包；安装钩子和转换过程均不会编译 LibreOffice、额外下载引擎，或查找用户的 LibreOffice 安装。npm 分发标准 `.tgz` 包；GitHub Release 引擎下载使用经校验的 XZ 传输包，供应用构建时准备并打包。两种分发路径及安装后转换验证见[打包指南](docs/packaging.md)和[发布流程](docs/building.md)。

## 做了哪些精简，为什么

`0.0.1` 分别在构建组件、安装资源和传输大小三个层面做精简：

| 层面 | 代码中的改动 | 原因 |
| --- | --- | --- |
| 原生构建 | 禁用 Java/Python、脚本与扩展、Base 数据库连接、PDF 导入、帮助与词典、图库/模板/图标主题、远程控制、在线更新，以及未使用的 curl/WebDAV/CMIS/LDAP 集成。 | 本地 OOXML → PDF 需要文档导入和 PDF 导出；桌面自动化、数据库访问、PDF 输入和在线服务会引入转换路径之外的依赖。 |
| 原生安装资源 | 校验后移除重复的 macOS `urelibs` 别名，删除 SDK 工具、启动器、Quick Look/Spotlight 资源、已禁用组件残留库、Basic/Python 脚本、Notebookbar、菜单和工具栏；清理非必要符号并保留动态导出，恢复和验证 macOS 签名。 | 避免应用内的转换引擎携带重复库、桌面资源和开发工具。 |
| WASM 构建及资源 | 为无界面的 Node Worker 构建 Writer、Calc、Impress，禁用 Java/Python、内置字体、OpenCL/OpenGL 和 Skia；从 `soffice.data` 移除图标归档、Notebookbar、菜单/工具栏、Android 示例文档、启动图片和 shell 资源。 | 保留文档引擎和 CPU 渲染路径，减少加载进 WASM 文件系统的资源。资源裁剪保留其余文件字节和元数据，只重算偏移；该步骤不改变加载器或已编译模块。 |
| 字体载荷 | 不捆绑字体集合，运行时加载部署环境提供的原始字体文件。 | 避免固定字体包的体积，让应用按文档需求选择字体，包括中日韩字形覆盖和 Office 兼容替代字体。 |
| 发布传输 | GitHub Release 引擎下载使用 XZ，分别校验压缩封装和精确安装 tar 的大小及哈希。 | 在不改变安装内容的情况下减少传输字节；这与资源裁剪、npm 的 `.tgz` 格式是不同层面的处理。 |

具体规则由[原生构建配置](engine/native/configure.mjs)、[原生资源裁剪](scripts/slim-native.mjs)、[WASM 构建配置](engine/wasm-source/autogen.input)和 [WASM 资源裁剪](engine/wasm-source/slim.mjs)维护。

原生资源裁剪移除 XSLT 资源及其过滤器注册、`CREDITS.fodt`，并且只在 `licenses/` 保留逐字节相同的第三方声明时移除安装目录中的 `LICENSE.html` 副本。移除的 XSLT 格式包括 Word 2003 XML、SpreadsheetML、UOF、DocBook 和 XHTML；二进制 Office 与 OOXML 转换过滤器仍然保留。

Windows 资源裁剪移除未使用的 OpenSSL、MSI 安装器、Shell 扩展、包括 `regactivex.dll` 的 ActiveX/SharePoint 集成、.NET CLI 绑定、桌面启动器、`program/wizards/` 和 `program/program/wizards/` 下的 Python 向导及品牌图片。转换 helper、扫描仪/GPG helper、已注册 UNO 组件和运行时 `.ini` 文件仍然保留，详见[打包说明](docs/packaging.md)。

Writer、Calc、Impress、二进制 Office 与 OOXML 过滤器、PDF 导出、用于内嵌 PDF/EMF 图形的 PDFium、共享排版与绘图库、图表、ICU 和语言资源仍然保留。原生构建的 `en-US` 选择的是界面资源，并不限制文档只能包含英文。必要的运行时配置和部分 UI 资源也会保留，因为文档服务仍依赖它们。每个引擎包还保留匹配的源码配方、补丁、哈希和许可声明。这些依赖也解释了为什么精简后的文档引擎仍有一定体积。

### 已记录的体积与保真度验证

仓库已有的本地候选包实测，将此前 `0.1.2` 的 gzip 包与独立版本 `0.0.1` 的 XZ 包比较。下载降幅同时包含载荷变化和压缩格式变化，不能全部归因于代码删除；这些是历史候选包数据，不是当前 npm 下载大小。MB 按 1,000,000 字节计算；解包大小为普通文件字节之和，不含文件系统分配开销和依赖包。

| 引擎 | 此前下载 | 0.0.1 下载 | 减少 | 此前解包 | 0.0.1 解包 |
| --- | ---: | ---: | ---: | ---: | ---: |
| macOS ARM64 | 98.85 MB | 60.49 MB | 38.81% | 301.04 MB | 269.43 MB |
| Node WASM | 56.47 MB | 35.85 MB | 36.51% | 210.24 MB | 190.64 MB |

已记录的本地 macOS ARM64 验证，以原生和 WASM 两种选择离线安装同一候选包。每个引擎使用六份合成 DOCX/XLSX/PPTX 文档，覆盖中英文、表格、公式和图片；与此前包相比，提取文字、页数和 96 DPI 渲染像素均一致。这些证据只覆盖上述样例与宿主，不代表所有文档保真或其他平台已通过验收。运行时测试还覆盖外部链接抑制、字体替换、限制和取消；[发布验证](docs/building.md)要求提供安装后运行引擎的证据。

## 构建指南

平台依赖、构建路径、并行度及包验证要求见[通用构建指南](docs/building.md)。
使用当前检出版本固定的源码和工具链，在相应平台上逐个构建、验证目标。

## 开发

[原生源码](engine/native/)和 [Node WASM 配方](engine/wasm-source/README.zh.md)使用同一个由 `engine/core` submodule 固定的 LibreOffice 修订版。[.gitmodules](.gitmodules) 管理上游 URL，gitlink 管理 commit。检出脚本保持 submodule 干净，并在被忽略的 `.build/` 下创建可丢弃的独立源码树用于应用补丁。本仓库维护组件选择和完整打包配方；匹配的源码与许可材料随引擎一起分发。

无需构建 LibreOffice 即可运行仓库检查：

```sh
pnpm verify:metadata
pnpm test
pnpm test:packaging
```

真实引擎测试还需要执行 `pnpm run build:adapter`、准备引擎载荷，并将 `LIBREOFFICE_RUNTIME_ENTRY` 设为 `packages/entry/lib/index.js` 的绝对路径。各平台顺序构建，按 CPU 和内存显式设置并行度；`pnpm gha:matrix` 展示 CI 矩阵。构建产物保持忽略。

[基准测试](benchmarks/README.zh.md)在独立的原生与 WASM 安装中测量公开磁盘 API，并区分首次字体索引和转换器复用。比较时使用相同的源码修订版、文档、字体目录和 PDF 选项；前端传输和绘制单独测量。
