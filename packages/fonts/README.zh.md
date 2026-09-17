# 可移植 Host 字体源

[English](README.md)

`@deepseek-ai/libreoffice-kit-fonts` 为 Host 辅助的浏览器文档渲染导出 `createFontSource` 及其字体请求／结果类型。它通过 JavaScript 和随包提供的 HarfBuzz WASM 模块运行于受支持的 Node.js 平台。依赖树不包含 LibreOffice 转换器、原生引擎或 Node LibreOffice WASM 包。

从本包导入 `createFontSource`，调用 `resolve(request)` 选择可复用的物理字面文字系统子集，再用 `read(id)` 获取调用方拥有的 sfnt 字节。原始字体族和样式保留；每个子集有由内容决定的浏览器注册别名。调用 `dispose()` 终止专属 Worker 并等待退出。匹配、缓存限额和取消语义参见[共用字体 API](../entry/README.zh.md#浏览器支持模块)。

实现只维护在 `packages/entry/src`。`pnpm build:fonts` 构建这些共用源码，只暂存两个字体运行时 bundle 和公开声明，并复制对应的 HarfBuzz 资源、源码配方及许可声明。`font-api.json` 记录源码／运行时哈希；`assets/font-subset.json` 记录独立构建的子集模块。预打包检查校验两份清单。安装和字体请求均不编译或下载资源。

本包与 `@deepseek-ai/libreoffice-kit-browser` 可独立于 Node 转换器的原生平台发布矩阵打包及验证，参见[预览候选流程](../../docs/building.md)。同时需要 Node 转换器包的现有消费者可继续使用等价的 `@deepseek-ai/libreoffice-kit/fonts` 导出。
