---
description: "预编译的 LibreOfficeKit 转换引擎、必需的 Node WASM 回退及其平台包。"
kind: "package-library"
---
# LibreOffice engines

[English](README.md) | 中文

## Summary

构建并分发预编译的 LibreOffice 引擎，用于磁盘上的 DOCX、XLSX 和 PPTX 转换。本仓库维护源码固定、补丁、原生 helper、共享 Node WebAssembly 引擎，以及 `packages/entry` 中的公开 Node API 和字体加载。

公开包 `@deepseek-ai/dsh-libreoffice-kit` 的 [Node API](packages/entry/README.zh.md) 记录了 `createConverter`、`render`、释放、资源限制和字体。每次转换都会写出一个新的 PDF，调用方可以读取它并交给现有的 PDF 阅读器。

DeepSeek Harness 维护 Cordis 文档提供方、授权和 Web 预览；本仓库维护独立的转换 API。

## Engine selection

已安装且匹配的 OS/CPU/libc 包会选择原生 helper。缺少该包，或宿主 glibc 版本低于原生包记录的最低版本时，选择共享的 WASM 引擎。损坏的已安装包和转换失败都会拒绝，而不会静默切换引擎。两个引擎的排版和 PDF 序列化都由 CPU 完成。

## Support

内部预览声明 macOS ARM64 和共享的 `@deepseek-ai/dsh-libreoffice-kit-wasm` 引擎。其他原生包保留为开发配方。本工作区共用根 pnpm 锁文件。GitHub Actions 构建并验证已声明的引擎，发布脚本将完整 tarball 托管在 internal 仓库 `deepseek-harness/libreoffice-kit` 的 `libreoffice-kit-v<version>` 下。应用构建时鉴权下载并打包已准备的引擎。[打包指南](docs/packaging.md)定义归档校验和安装限制；[发布指南](docs/building.md)说明构建时凭据、资格验证和发布。

## Development

[原生源码](engine/native/)和 [Node WASM 配方](engine/wasm-source/README.zh.md)编译同一个固定的 LibreOffice 修订版。上游源码在构建时获取到被忽略的目录；仓库只跟踪修订版固定信息、补丁以及我们自己的 C++ 和构建脚本。对应的源码、补丁、哈希和再分发声明随每个引擎包一起分发。本仓库也负责组件选择、去重、桌面资源裁剪、符号清理和签名。准备好的产物必须匹配完整的配置、补丁、暂存和瘦身配方；不需要外部瘦身脚本。不捆绑任何字体集合。

在此目录运行 `pnpm verify:metadata`、`pnpm test` 和 `pnpm test:packaging`；它们不需要构建 LibreOffice。原生和 WASM 载荷由 `pnpm gha:matrix` 声明的对应 CI runner 构建。

[基准测试](benchmarks/README.zh.md)使用生成的文档和相互独立的已安装原生/WASM 布局。它们测量公开的磁盘 API，并把首次字体索引与转换器复用分开。原生和 WASM 的比较要求相同的源码修订版、文档字节、字体根和 PDF 选项。前端传输和绘制是独立的测量项。
