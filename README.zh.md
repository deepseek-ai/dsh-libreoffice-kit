---
description: "预编译的 LibreOfficeKit 转换引擎、可选的 Node WASM 回退及其平台包。"
kind: "package-library"
---
# LibreOffice engines

[English](README.md) | 中文

## Summary

构建并分发预编译的 LibreOffice 引擎，用于磁盘上的 DOCX、XLSX 和 PPTX 转换。本仓库维护源码固定、补丁、原生 helper、共享 Node WebAssembly 引擎，以及 `packages/entry` 中的公开 Node API 和字体加载。

公开包 `@deepseek-ai/libreoffice-kit` 的 [Node API](packages/entry/README.zh.md) 记录了 `createConverter`、`render`、释放、资源限制和字体。每次转换都会写出一个新的 PDF，调用方可以读取它并交给现有的 PDF 阅读器。

DeepSeek Harness 维护 Cordis 文档提供方、授权和 Web 预览；本仓库维护独立的转换 API。

## Engine selection

已安装且匹配的 OS/CPU/libc 包会选择原生 helper。缺少该包，或宿主 glibc 版本低于原生包记录的最低版本时，选择共享的 WASM 引擎。损坏的已安装包和转换失败都会拒绝，而不会静默切换引擎。两个引擎的排版和 PDF 序列化都由 CPU 完成。

## Support

内部预览声明 macOS ARM64 和共享的 `@deepseek-ai/libreoffice-kit-wasm` 引擎。其他原生包保留为开发配方。本工作区共用根 pnpm 锁文件。GitHub Actions 构建并验证已声明的引擎，发布脚本将完整 tarball 托管在 internal 仓库 `deepseek-harness/libreoffice-kit` 的 `libreoffice-kit-v<version>` 下。应用构建时鉴权下载并打包已准备的引擎。[打包指南](docs/packaging.md)定义归档校验和安装限制；[发布指南](docs/building.md)说明构建时凭据、资格验证和发布。

## Size reduction

转换构建禁用桌面图库、模板和图标、Base 数据连接、脚本与扩展、PDF 导入、帮助索引、LDAP，以及未使用的网络提供方。原生打包移除重复的 macOS 库别名、已禁用组件的残留库、Basic/Python 脚本、Notebookbar、菜单、工具栏，以及桌面启动与系统集成资源。符号清理保留动态导出，并验证 macOS 签名与库依赖。

WASM 打包从文件系统镜像中移除明确列出的桌面资源，重新生成偏移，保留的字节、加载器和已编译模块不变。引擎下载使用 XZ；准备步骤分别验证压缩传输包和精确的安装 tar，再供应用打包。字体在运行时提供。Writer、Calc、Impress、PDF 导出、ICU、共享排版库、Skia、图表、源码回执和许可证声明均保留。

下表为本地候选包实测，将此前 `0.1.2` 的 gzip 包与独立版本 `0.0.1` 的 XZ 包比较。MB 按 1,000,000 字节计算；解包大小为普通文件字节之和，不含文件系统分配开销和依赖包。

| 引擎 | 此前下载 | 当前下载 | 减少 | 此前解包 | 当前解包 |
| --- | ---: | ---: | ---: | ---: | ---: |
| macOS ARM64 | 98.85 MB | 60.49 MB | 38.81% | 301.04 MB | 269.43 MB |
| CPU WASM | 56.47 MB | 35.85 MB | 36.51% | 210.24 MB | 190.64 MB |

本地 macOS ARM64 验证以原生和 WASM 两种选择离线安装同一候选包。每个引擎使用六份合成 DOCX/XLSX/PPTX 文档，覆盖中英文、表格、公式和图片；与此前包相比，提取文字、页数和 96 DPI 渲染像素均一致。运行时检查覆盖外部链接抑制、字体替换、限制与取消。这些证据覆盖上述样例与宿主，不代表穷尽文档保真度或完成其他平台认证。[打包说明](docs/packaging.md)定义归档完整性，[发布验证](docs/building.md)说明独立发布流程。

## Development

[原生源码](engine/native/)和 [Node WASM 配方](engine/wasm-source/README.zh.md)编译同一个由 `engine/core` submodule 固定的 LibreOffice 修订版。[.gitmodules](.gitmodules) 记录上游 URL，gitlink 记录 commit。检出脚本按需初始化 submodule，并在被忽略的 `.build/` 下创建独立源码树用于应用补丁。对应的源码配方、解析后的固定信息、补丁、哈希和再分发声明随每个引擎包一起分发。本仓库也负责组件选择、去重、桌面资源裁剪、符号清理和签名。准备好的产物必须匹配完整的配置、补丁、暂存和瘦身配方；不需要外部瘦身脚本。不捆绑任何字体集合。

在此目录运行 `pnpm verify:metadata`、`pnpm test` 和 `pnpm test:packaging`；它们不需要构建 LibreOffice。原生和 WASM 载荷由 `pnpm gha:matrix` 声明的对应 CI runner 构建。

[基准测试](benchmarks/README.zh.md)使用生成的文档和相互独立的已安装原生/WASM 布局。它们测量公开的磁盘 API，并把首次字体索引与转换器复用分开。原生和 WASM 的比较要求相同的源码修订版、文档字节、字体根和 PDF 选项。前端传输和绘制是独立的测量项。
