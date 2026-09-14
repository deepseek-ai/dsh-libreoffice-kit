/** Verify one offline candidate on a minimal glibc host, retaining real loader and conversion evidence. */
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { baseLibraries } from './stage-linux-runtime.mjs';
import { enginePrefix, hostTarget, kitPackageName, root } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';
import { verifyPackedInstall } from './verify-packed-install.mjs';

const expectedBackend = process.env.EXPECTED_BACKEND;
assert(['native', 'wasm'].includes(expectedBackend), 'The container requires an expected native or WASM backend');
const output = resolve(process.env.QUALIFICATION_OUTPUT ?? '/results');
mkdirSync(output, { recursive: true });
const result = verifyPackedInstall(resolve(process.argv[2]), { wasmOnly: false, expectedBackend, keep: '/tmp/qualified-consumer' });
const directory = join(result.retainedInstallation, 'node_modules', `${enginePrefix}-${hostTarget()}`);
const prebuild = JSON.parse(readFileSync(join(directory, 'prebuilds.json'), 'utf8'));
assert(prebuild.engine.glibcMinimum, 'Native ELF-derived minimum was not staged');
const hostGlibc = process.report.getReport().header.glibcVersionRuntime;
const records = [];
if (expectedBackend === 'native') {
  const program = realpathSync(join(directory, prebuild.engine.programDirectory));
  const loader = process.arch === 'arm64' ? 'ld-linux-aarch64.so.1' : 'ld-linux-x86-64.so.2';
  for (const name of Object.keys(prebuild.files).filter(name => /^(bin|program)\//.test(name))) {
    const file = join(directory, name);
    const fd = openSync(file, 'r');
    const header = Buffer.alloc(4);
    try { readSync(fd, header); } finally { closeSync(fd); }
    if (!header.equals(Buffer.from([127, 69, 76, 70]))) continue;
    const text = run('ldd', [file], { env: { ...process.env, LC_ALL: 'C', LD_LIBRARY_PATH: program } });
    assert(!text.includes('not found'), `Unresolved native dependency for ${name}: ${text}`);
    const dependencies = [];
    for (const line of text.trim() === 'statically linked' ? [] : text.trim().split('\n')) {
      const mapped = /^\s*(\S+)\s+=>\s+(\/\S+)\s+\(/.exec(line);
      const direct = /^\s*(\/\S+)\s+\(/.exec(line);
      if (!mapped && !direct) {
        assert(/^\s*linux-vdso\.so\.\d+\s+\(/.test(line), `Unrecognized ldd output for ${name}: ${line}`);
        continue;
      }
      const library = mapped?.[1] ?? basename(direct[1]);
      const resolved = realpathSync(mapped?.[2] ?? direct[1]);
      const bundled = resolved.startsWith(`${program}/`);
      assert(bundled || baseLibraries.has(library) || library === loader, `Unexpected host library for ${name}: ${library} => ${resolved}`);
      if (Object.hasOwn(prebuild.files, `${prebuild.engine.programDirectory}/${library}`))
        assert(bundled, `Bundled library resolved from the host: ${library} => ${resolved}`);
      dependencies.push({ library, resolved, bundled });
    }
    records.push({ file: name, dependencies });
  }
  assert(records.length > 0, 'No native ELF files were inspected');
}
const lifecycle = run(process.execPath, ['--test', join(root, 'test/runtime-engine.test.mjs')], {
  timeout: 300_000,
  env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '',
    LIBREOFFICE_RUNTIME_ENTRY: join(result.retainedInstallation, 'node_modules', ...kitPackageName.split('/'), 'lib/index.js'),
    LIBREOFFICE_RUNTIME_EXPECT_BACKEND: expectedBackend },
});
writeFileSync(join(output, 'lifecycle.log'), lifecycle);
writeFileSync(join(output, 'loader.json'), `${JSON.stringify(records, null, 2)}\n`);
const receipt = { hostGlibc, nativeGlibcMinimum: prebuild.engine.glibcMinimum, installedNative: true,
  expectedBackend, ...result, inspectedElfFiles: records.length,
  checks: { installedSmoke: 'three formats and HTTP positive control followed by zero external requests',
    lifecycle: 'runtime-engine input/output/timeout, cancellation and disposal checks',
    loader: expectedBackend === 'native' ? 'every native ELF resolves only bundled or basic OS libraries' : 'native remains installed; actual converter selects WASM on this older glibc host' } };
writeFileSync(join(output, 'result.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
