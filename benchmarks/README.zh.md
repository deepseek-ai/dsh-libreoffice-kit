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

## 字体元数据缓存对照

`font-cache.mjs` 让两个已构建 adapter 使用相同的已安装引擎，测量性能。`font-cache-regression.mjs` 单独比较全部 PDF 页面和直接 PNG，并执行第二次基线运行以检测样例自身的不稳定性。源码基线为 `96cc7d8`（文件树与 `2ba08c5` 一致）；两边均使用 `0.0.3` 引擎。每份 checkout 执行 `pnpm build:adapter` 后，用 `font-cache-stage.mjs --baseline <基线包目录> --candidate <候选包目录> --dependencies <已安装的node_modules> --output <新目录>` 暂存其 `packages/entry`。依赖目录必须包含 fontkit、fflate、saxes 和宿主平台的匹配版本引擎。

公开输入使用[固定修订版的 Carlito Regular](https://raw.githubusercontent.com/google/fonts/07ace6abab87a122865e5cb82c7540b39551edb2/ofl/carlito/Carlito-Regular.ttf)，下载到私有临时目录。字体按 [SIL Open Font License](https://github.com/google/fonts/blob/07ace6abab87a122865e5cb82c7540b39551edb2/ofl/carlito/OFL.txt) 分发；不要提交下载的字体。`font-cache-fixtures.mjs` 校验 SHA-256 `f6418f708baede9789daef5d458c0f53d2a888af9820e8062934e504fedc6595`，生成使用该字体的 DOCX/PPTX/XLSX 输入：

```sh
node benchmarks/font-cache-fixtures.mjs --font /tmp/kit-benchmark/Carlito-Regular.ttf --output /tmp/kit-benchmark/fixtures
python3 -m pip install PyMuPDF==1.26.5 Pillow==11.3.0 numpy==2.0.2
node benchmarks/font-cache-regression.mjs --baseline /tmp/kit-benchmark/staged/baseline/lib/index.js --candidate /tmp/kit-benchmark/staged/candidate/lib/index.js --manifest /tmp/kit-benchmark/fixtures/inputs.json --output /tmp/kit-benchmark/regression
node benchmarks/font-cache.mjs --baseline /tmp/kit-benchmark/staged/baseline/lib/index.js --candidate /tmp/kit-benchmark/staged/candidate/lib/index.js --manifest /tmp/kit-benchmark/fixtures/inputs.json --output /tmp/kit-benchmark/performance --repetitions 7
```

清单为 `{ "id": "anonymous-case", "path": "/absolute/input.docx", "options": { "fontDirectories": ["/absolute/fonts"] } }` 条目组成的数组，options 可省略。回归使用这些逐样例选项；性能测试使用默认系统/Office 字体发现来测量已安装字体启动。各命令在无其他自有负载的宿主上串行运行，不清空操作系统缓存。新进程空缓存和磁盘命中测试对每个输入至少执行七组交替先后顺序的前后对照。同进程复用执行七组进程对照，每进程操作两次；不同文档连续处理执行七组进程对照。1/2/4 并发分别测量空缓存和磁盘命中启动，每种配置一组前后对照；这些并发结果是描述性观测，并非七组估计。

两边均只在 Worker 内插桩，计数同步字体读取字节、读取调用、元数据 inspect 调用和完成扫描。时钟包含 converter 创建、渲染和 PDF 读取/头校验，不包含模块导入、dispose 或强制 GC。插桩有额外开销，两边必须使用相同 hook。报告中位数及完整范围，不选择有利样本。磁盘命中时元数据 inspect 必须为零，同时开始的首次操作必须共享一次扫描。

进程树 RSS 在 POSIX 上每 100 ms 采样，Windows 缺少该采样支持时明确记录。保存父进程操作前、完成时、GC 后和 dispose/GC 后的 `heapUsed`、`external`、`arrayBuffers` 与 RSS。RSS 不等于可达 JavaScript 内存或字体 Buffer 所有权；对象不可达后，分配器和操作系统缓存仍可能保留页面。仅凭 RSS 持平或偏高不能判定泄漏。

所有工作目录均为私有。回归输出包含私有 PDF、图片、路径、含文本的清单和诊断指纹；性能任务也保留私有路径、PDF 和缓存。只发布审核过的 `samples.json`、`environment.json`、回归 `summary.json` 和匿名统计。CI 在 Windows native 和 Linux WASM 上只上传公开样例的匿名摘要，不上传字体或缓存文件。这些样例的像素一致仅是有限证据，不保证所有文档都无误。
