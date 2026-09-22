# Node WASM engine recipe

[English](README.md) | 中文

本配方为 Node worker 构建固定的 LibreOffice Writer、Calc 和 Impress 引擎。它提供入口包所需的回退资源。运行时字体加载和转换归属见 [Node API](../../packages/entry/README.zh.md)。

`engine/core` submodule 固定与原生构建共用的 LibreOffice URL 和 commit。[source.json](source.json) 记录 LibreOffice 版本信息并固定 Emscripten；[source.mjs](source.mjs) 解析完整配方。官方[上游构建说明](https://github.com/LibreOffice/core/blob/bce0998afefdbc355585ca324285661a2170ba77/static/README.wasm.md)定义了编译器前置条件。macOS 构建还需要 GNU make、autoconf、automake、pkg-config、gperf 和 Ninja。`node scripts/checkout-wasm.mjs` 按需初始化保持原样的 submodule；用于应用补丁的源码、SDK、第三方归档和构建输出默认放在仓库根目录的 `.build/wasm/`。

[build.mjs](build.mjs) 提供显式阶段：`prepare` 检查提交并应用补丁；`verify` 校验准备好的配方；`configure` 生成构建配置；`compile` 写出成功构建回执；`package` 检查该回执，保留加载器和已编译模块，并通过 [slim.mjs](slim.mjs) 重打包资源镜像。`build` 会依次执行这些阶段。路径可以通过 `--source`、`--emsdk`、`--build`、`--tarballs` 和 `--output` 提供。

这些补丁提供无头 LibreOfficeKit 适配器、Node 和 worker 执行、受检栈空间、有界内存增长、设备字体回调，以及禁用外部文档更新。它们不会在 WASM 中挂载 Host 文件系统。数据镜像包含程序资源且不含字体文件；运行时字体导入保留原始字体字节。图像降采样使用 LibreOffice 的 CPU 过滤器。

[stage.mjs](stage.mjs) 需要 `--source`、`--emsdk`、`--build` 和 `--bundle`。它从已记录的构建配置中读取外部源码压缩包目录，并重新校验成功构建，然后把资源、源码固定信息、补丁、完整源码差异和再分发声明暂存到 `packages/wasm`。CommonJS 加载器名为 `soffice.cjs`，因为其所在的 npm 包使用 ESM。引擎选择和发布打包使用[共享打包规则](../../docs/packaging.md)。

编译回执绑定源码变更、配置、工具链、shim、补丁和原始资源哈希。这些输入变化后必须重新编译。打包阶段单独记录原始编译哈希、打包配方、删除的路径与字节数，以及最终资源哈希。仅修改打包配方时，可以在新输出目录中复用经过验证的编译产物；保留的资源字节与元数据属性不变，仅重新生成偏移和总大小。已存在的输出目录不可变：不同的构建使用新目录。构建和打包是维护者操作；消费方安装既不运行编译器，也不下载。
