# Conversion benchmarks

[English](README.md) | 中文

这些描述性基准在同一台机器上比较原生 LibreOfficeKit 和 WASM CPU。它们测量已安装的公开磁盘 API。请使用相同的引擎源码修订版、字体根、输入字节和导出选项；运行时不要让其他自有构建或基准争用 CPU 资源。PDF 文本、字体和排版需要单独的功能验证。

在安装了 `python-docx`、`openpyxl`、`python-pptx` 和 `Pillow` 的 Python 环境中生成固定的合成文档。生成器把上述包版本和随机种子记录在 `generator.json` 中，固定 OOXML 时间戳，并把六个输入哈希写入 `fixtures.json`。其 DOCX 和 PPTX 用例包含图像；XLSX 用例包含表格和公式，不包含图像。

```sh
python3 benchmarks/fixtures.py .build/benchmark
node benchmarks/convert.mjs \
  --manifest .build/benchmark/fixtures.json \
  --output .build/comparison \
  --native-entry /absolute/native-install/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js \
  --wasm-entry /absolute/wasm-install/node_modules/@deepseek-ai/libreoffice-kit/lib/index.js \
  --repetitions 3
node benchmarks/report.mjs \
  --results .build/comparison \
  --manifest .build/benchmark/fixtures.json
```

使用全新的输出目录和相互隔离的包安装：原生安装包含其已构建的平台包，WASM 安装不包含该包。`--case FILE` 选择单个确切的输入；请把同一选择同时传给转换和报告。

每个新样本都启动一个进程和一个转换器。子进程继承一份平台路径、主目录/临时目录、区域/时区和显示连接设置的允许列表；凭据、`NODE_OPTIONS` 以及加载器/驱动覆盖都不会被继承。环境记录只描述该策略，不记录取值。上报的时钟从 `createConverter` 和 `render` 开始，到 PDF 输出关闭为止。复用任务创建一个转换器，单独记录其第一次转换，并测量后续重复项。只保留字体元数据；每次转换都启动全新的原生引擎进程或 WASM Worker。模块导入、PDF 检查、转换器释放、网络传输和前端展示不在这些时钟之内。操作系统磁盘缓存不会被清除，因此新进程并不意味着冷文件系统缓存。

控制器在整个任务期间每 100 ms 采样一次子进程及其后代的总 RSS，包括导入、校验和释放。采样峰值可能遗漏更短的尖峰，也不测量保留内存。新样本各自拥有自己的任务峰值；所有复用迭代共享一个峰值。Node 自身的 `maxRSS` 不包含原生后代，单独保留。采样失败和缺失观测都会在报告中显式保留。

报告器在专门写出 `summary.json` 和 `report.md` 之前，会校验每个预期用例、变体、任务、迭代和输入哈希。失败、缺失或重复的任务会使报告失败。比值等于原生中位数除以所选变体的中位数；大于 1 表示该变体更快。JSON 以原始精度保留所有时钟，包括被排除的首次复用转换和进程采样诊断。

`node --test test/benchmark.test.mjs test/benchmark-report.test.mjs` 在不运行 LibreOffice 性能测量的前提下检查传输、进程清理、可手工计算的统计量、缺失证据和报告独占写出。

发布的证据必须隐去本地工作区路径，并省略归档账号名、数字所有者和文件系统扩展属性。Office 用例会清除从 writer 模板继承的最后修改字段。对既有证据做纯元数据变更时，需要当前校验和以及一份把脱敏文件与原始测量关联起来的记录；它们不构成新的基准运行。
