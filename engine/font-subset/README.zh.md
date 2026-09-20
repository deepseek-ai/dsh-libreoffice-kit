# Host 字体子集运行时

[English](README.md)

Node 字体源使用 HarfBuzz 提取单独的 sfnt 字面，并在选择可复用 Unicode 文字系统分区时保留字形塑形。[source.json](source.json) 固定 harfbuzzjs、其 HarfBuzz 子模块和 Emscripten。上游子集模块使用固定的 65 MiB 堆；本配方允许堆增长，WebAssembly 构建上限为 2 GiB。输入限制和保留子集缓存预算不能约束所有临时子集分配。

准备独立源码目录和 SDK，然后构建：

```sh
git clone --depth 1 --branch v1.6.1 --recurse-submodules --shallow-submodules https://github.com/harfbuzz/harfbuzzjs.git .build/font-subset/harfbuzzjs
git clone https://github.com/emscripten-core/emsdk.git .build/font-subset/emsdk
git -C .build/font-subset/emsdk checkout --detach 5eb0bde7585670252e8ba05e9d361627bffd08b5
python3 .build/font-subset/emsdk/emsdk.py install 4.0.10
python3 .build/font-subset/emsdk/emsdk.py activate 4.0.10
node scripts/build-font-subset.mjs
node scripts/build-font-subset.mjs --verify
```

构建检查精确提交、已跟踪源码无修改及编译器版本。它仅调整编译和链接参数，不修改上游源码。`--source`、`--emsdk` 和 `--target` 接受已有源码、SDK 和暂存目录；另一个构建运行时，应使用独立的 SDK 缓存。

生成的 `packages/entry/assets/font-subset.json` 记录精确源码固定信息、配方哈希，以及 WASM 模块、源码配方、配置、导出列表和许可声明的校验和。Node API 打包时验证该回执。运行时初始化前会核对 WASM 字节与随包回执。安装和字体请求不会构建或下载模块。

运行字体子集测试前需构建该运行时。可移植测试字体比较阿拉伯文、印度文字、补充平面文字及可变字体的塑形和轮廓，覆盖 TTC/dfont 提取，并强制分配超过上游堆大小的输入。测试还覆盖缓存淘汰、字体索引刷新、Worker 释放和无效模块回执。
