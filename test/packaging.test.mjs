import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { enginePrefix, kitDirectory, kitManifest, kitNativeTargets, packageMatrix, readJson, root, wasmName } from '../scripts/platform-matrix.mjs';
import { regularFile, safePath, verifyEngineMetadata, verifyEnginePackage, verifyNativeHeader, verifyNativeImage, verifyNoInstallHooks } from '../scripts/verify-artifacts.mjs';
import { engineFamilyVersion, verifyKitMetadata, verifyKitPackage } from '../scripts/verify-kit.mjs';
import { packRelease, stagePackage, workflowRepositoryUrl } from '../scripts/pack-release.mjs';
import { npm, run } from '../scripts/pack-utils.mjs';
import { verifyRelease } from '../scripts/verify-release.mjs';
import { configureFlags, verifyConfigureInput } from '../engine/native/configure.mjs';
import { packKitManifest } from '../scripts/pack-kit-manifest.mjs';

const row = packageMatrix().find((row) => row.prebuild.platform === 'darwin-arm64');
const unbuilt = () => ({ ...structuredClone(row.prebuild), status: 'unbuilt', files: {}, source: null, licenses: [] });

/** Resolve workspace versions before applying the workspace's pnpm pack hook. */
function packedAdapterManifest(source = kitManifest()) {
  const manifest = structuredClone(source);
  for (const field of ['dependencies', 'optionalDependencies']) {
    for (const name of Object.keys(manifest[field] ?? {})) if (manifest[field][name] === 'workspace:*') manifest[field][name] = engineFamilyVersion();
  }
  return packKitManifest(manifest);
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'libreoffice-kit-packaging-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

test('the workspace adapter passes the manifest check the engine lane runs', () => {
  assert.equal(verifyKitPackage(kitDirectory()).name, kitManifest().name);
});

test('adapter packages retain the license and notices', (t) => {
  const directory = scratch(t);
  writeFileSync(join(directory, 'package.json'), JSON.stringify(kitManifest()));
  for (const file of ['LICENSE', 'NOTICE']) {
    assert.throws(() => verifyKitPackage(directory), { message: `Missing package artifact: ${file}` });
    writeFileSync(join(directory, file), readFileSync(join(kitDirectory(), file)));
  }
  assert.equal(verifyKitPackage(directory).name, kitManifest().name);
});

test('the internal preview declares macOS ARM64 and WASM while other recipes remain available for development', () => {
  const matrix = packageMatrix();
  assert.equal(matrix.length, 7);
  for (const row of matrix) verifyEngineMetadata(row.manifest, row.prebuild);
  const manifest = kitManifest();
  verifyKitMetadata(manifest);
  assert.deepEqual(kitNativeTargets(manifest), ['darwin-arm64']);
  const missingWasm = structuredClone(manifest);
  delete missingWasm.dependencies[wasmName];
  assert.throws(() => verifyKitMetadata(missingWasm), /required dependency/);
  assert.throws(() => verifyKitMetadata(manifest, true), /engine family version/);
  verifyKitMetadata(packedAdapterManifest(manifest), true);
});

test('the installed adapter preserves the canonical optional list and pins prepared engine versions', () => {
  const source = kitManifest();
  const manifest = packedAdapterManifest(source);
  assert.deepEqual(Object.keys(manifest.optionalDependencies), Object.keys(source.optionalDependencies ?? {}));
  const version = engineFamilyVersion();
  const url = () => version;
  assert.equal(manifest.dependencies[wasmName], url(wasmName));
  for (const native of kitNativeTargets(source)) assert.equal(manifest.optionalDependencies[`${enginePrefix}-${native}`], url(`${enginePrefix}-${native}`));
  for (const name of ['fflate', 'fontkit', 'saxes']) assert.equal(manifest.dependencies[name], source.dependencies[name]);
  verifyKitMetadata(manifest, true);
  const missing = structuredClone(manifest);
  delete missing.optionalDependencies[`${enginePrefix}-darwin-arm64`];
  assert.throws(() => verifyKitMetadata(missing, true), /Optional dependency matrix/);
  const extra = structuredClone(manifest);
  extra.optionalDependencies[`${enginePrefix}-win32-x64`] = engineFamilyVersion();
  assert.throws(() => verifyKitMetadata(extra, true), /Optional dependency matrix/);
});

test('adapter engine declarations reject unknown native packages and mismatched ranges', () => {
  const source = kitManifest();
  for (const name of [`${enginePrefix}-freebsd-x64`, 'unrelated-native']) {
    const invalid = structuredClone(source);
    invalid.optionalDependencies = { [name]: 'workspace:*' };
    assert.throws(() => verifyKitMetadata(invalid), /Unknown native optional dependency/);
  }
  const invalidSource = structuredClone(source);
  invalidSource.optionalDependencies = { [`${enginePrefix}-darwin-arm64`]: engineFamilyVersion() };
  assert.throws(() => verifyKitMetadata(invalidSource), /engine family version/);
  const invalidPacked = packedAdapterManifest(source);
  invalidPacked.optionalDependencies[`${enginePrefix}-darwin-arm64`] = '0.0.0';
  assert.throws(() => verifyKitMetadata(invalidPacked, true, ['darwin-arm64']), /engine family version/);
  const optionalWasm = packedAdapterManifest(source);
  optionalWasm.optionalDependencies[wasmName] = engineFamilyVersion();
  assert.throws(() => verifyKitMetadata(optionalWasm, true), /must not be optional/);
});

test('workflow repository identity requires a repository and an HTTPS origin', () => {
  assert.equal(workflowRepositoryUrl({}), undefined);
  assert.equal(workflowRepositoryUrl({ GITHUB_REPOSITORY: 'fixture-owner/kit' }), 'git+https://github.com/fixture-owner/kit.git');
  assert.equal(workflowRepositoryUrl({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'fixture-owner/kit', GITHUB_SERVER_URL: 'https://github.example.com' }),
    'git+https://github.example.com/fixture-owner/kit.git');
  for (const repository of [undefined, '', 'owner/repo/extra', 'owner repo/repo']) {
    assert.throws(() => workflowRepositoryUrl({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repository }), /GITHUB_REPOSITORY/);
  }
  for (const server of ['http://github.example.com', 'https://github.example.com/path', 'https://user:pass@github.example.com',
    'https://github.example.com?query', 'https://github.example.com#fragment']) {
    assert.throws(() => workflowRepositoryUrl({ GITHUB_REPOSITORY: 'owner/repo', GITHUB_SERVER_URL: server }), /HTTPS origin/);
  }
});

test('staged engine tarballs carry workflow identity without changing source bytes or executable modes', (t) => {
  const work = scratch(t);
  for (const name of [`${enginePrefix}-fixture`]) {
    const dir = join(work, 'engine');
    mkdirSync(join(dir, 'src'), { recursive: true });
    for (const file of ['src/index.js', 'README.md', 'LICENSE', 'NOTICE']) writeFileSync(join(dir, file), 'fixture\n');
    chmodSync(join(dir, 'src/index.js'), 0o755);
    const manifest = { name, version: '1.0.0', files: ['src/'], repository: { type: 'git', url: 'git+https://github.com/public-owner/source.git', directory: 'native/libreoffice/packages/fixture' } };
    const source = `${JSON.stringify(manifest)}\n`;
    writeFileSync(join(dir, 'package.json'), source);
    const staged = `${dir}-staged`;
    const repositoryUrl = workflowRepositoryUrl({ GITHUB_REPOSITORY: 'workflow-owner/release' });
    stagePackage(dir, staged, manifest, repositoryUrl);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), source);
    assert.equal(manifest.repository.url, 'git+https://github.com/public-owner/source.git');
    assert.deepEqual(readJson(join(staged, 'package.json')).repository, { ...manifest.repository, url: repositoryUrl });
    assert.deepEqual(readFileSync(join(staged, 'src/index.js')), readFileSync(join(dir, 'src/index.js')));
    if (process.platform !== 'win32') assert.equal(statSync(join(staged, 'src/index.js')).mode & 0o777, 0o755);
    const [packed] = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--pack-destination', work], staged, work));
    const archived = JSON.parse(run('tar', ['-xOf', join(work, packed.filename), 'package/package.json']));
    assert.deepEqual(archived.repository, { ...manifest.repository, url: repositoryUrl });
    assert.ok(packed.files.some(file => file.path === 'src/index.js'));
    if (process.platform !== 'win32') assert.equal(packed.files.find(file => file.path === 'src/index.js').mode, 0o755);
    const local = `${dir}-local`;
    stagePackage(dir, local, manifest, undefined);
    assert.deepEqual(readJson(join(local, 'package.json')), manifest);
  }
});

test('release selection rejects empty, duplicate and unknown arrays before packing', () => {
  for (const platforms of [[], ['wasm', 'wasm'], ['darwin-arm64', 'darwin-arm64']])
    assert.throws(() => verifyRelease({ platforms, metadataOnly: true }), /nonempty and unique/);
  assert.throws(() => verifyRelease({ platforms: ['freebsd-x64'], metadataOnly: true }), /Unknown release target/);
});

test('an unbuilt target cannot be packed even with valid metadata', (t) => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify(row.manifest));
  writeFileSync(join(dir, 'prebuilds.json'), JSON.stringify(unbuilt()));
  assert.throws(() => verifyEnginePackage(dir), /unbuilt target cannot be packed/);
  const fake = unbuilt();
  fake.files['bin/libreoffice-kit'] = '0'.repeat(64);
  assert.throws(() => verifyEngineMetadata(row.manifest, fake), /Unbuilt target must not claim/);
  // The fixture keeps the engine workspace where the adapter's relative manifest path resolves.
  const repo = join(dir, 'native/libreoffice');
  mkdirSync(join(repo, 'packages'), { recursive: true });
  mkdirSync(join(repo, 'packages/entry'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), JSON.stringify(readJson(join(root, 'package.json'))));
  writeFileSync(join(repo, 'packages/entry/package.json'), JSON.stringify(kitManifest()));
  for (const entry of packageMatrix()) {
    const directory = join(repo, 'packages', entry.prebuild.platform);
    mkdirSync(directory);
    const prebuild = structuredClone(entry.prebuild);
    if (prebuild.platform === 'linux-x64-glibc') Object.assign(prebuild, { status: 'unbuilt', files: {}, source: null, licenses: [] });
    writeFileSync(join(directory, 'package.json'), JSON.stringify(entry.manifest));
    writeFileSync(join(directory, 'prebuilds.json'), JSON.stringify(prebuild));
  }
  assert.throws(() => packRelease(join(dir, 'release'), ['linux-x64-glibc'], repo), /unbuilt target cannot be packed/);
});

test('native manifest rejects OS, CPU, libc, path and receipt mismatches', () => {
  assert.throws(() => verifyEngineMetadata({ ...row.manifest, cpu: ['x64'] }, unbuilt()), /os\/cpu\/libc/);
  const traversal = unbuilt(); traversal.engine.programDirectory = 'program/../../outside';
  assert.throws(() => verifyEngineMetadata(row.manifest, traversal), /Unsafe package path/);
  const built = unbuilt(); built.status = 'built';
  assert.throws(() => verifyEngineMetadata(row.manifest, built), /requires source/);
  const wasm = packageMatrix().find((entry) => entry.prebuild.platform === 'wasm');
  assert.throws(() => verifyEngineMetadata({ ...wasm.manifest, os: ['linux'] }, wasm.prebuild), /every host/);
});

test('glibc minima are optional for old receipts and valid only on glibc targets', () => {
  for (const row of packageMatrix()) {
    const prebuild = structuredClone(row.prebuild);
    delete prebuild.engine.glibcMinimum;
    assert.doesNotThrow(() => verifyEngineMetadata(row.manifest, prebuild));
    prebuild.engine.glibcMinimum = '2.38';
    if (prebuild.platform.endsWith('-glibc')) {
      assert.doesNotThrow(() => verifyEngineMetadata(row.manifest, prebuild));
      for (const invalid of [null, 2.38, '2', '02.38', '2.38.0.1', 'GLIBC_2.38', '2.38 ', '9007199254740992.0']) {
        prebuild.engine.glibcMinimum = invalid;
        assert.throws(() => verifyEngineMetadata(row.manifest, prebuild), /Invalid native glibcMinimum/);
      }
    } else assert.throws(() => verifyEngineMetadata(row.manifest, prebuild), /Invalid native glibcMinimum/);
  }
});

test('paths reject escape sequences and symlinks', (t) => {
  for (const path of ['', '/absolute', '../escape', 'program/../../escape', 'program\\file', 'C:/file', 'program//file', 'program/./file', 'program/\0file'])
    assert.throws(() => safePath(path), /Unsafe package path/);
  assert.equal(safePath('program/LibreOffice.app/Contents/Frameworks/core.dylib'), 'program/LibreOffice.app/Contents/Frameworks/core.dylib');
  const dir = scratch(t);
  mkdirSync(join(dir, 'program'));
  writeFileSync(join(dir, 'regular'), 'bytes');
  assert.throws(() => regularFile(dir, 'program/missing'), /Missing package artifact/);
  if (process.platform !== 'win32') {
    symlinkSync('../regular', join(dir, 'program/link'));
    assert.throws(() => regularFile(dir, 'program/link'), /Not a regular/);
  }
});

test('installation has no compilation, downloads, or unresolved dependency ranges', () => {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare'])
    assert.throws(() => verifyNoInstallHooks({ name: 'bad', scripts: { [hook]: 'node build.mjs' } }), /forbidden install/);
  assert.throws(() => verifyNoInstallHooks({ name: 'bad', gypfile: true }), /CLI bins/);
  assert.throws(() => verifyNoInstallHooks({ name: 'bad', dependencies: { library: '^1.0.0' } }), /pin a published version/);
});

test('minimal architecture headers do not pass executable release validation', (t) => {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); bytes.writeUInt32LE(2, 12);
  verifyNativeHeader(bytes, 'darwin-arm64');
  assert.throws(() => verifyNativeHeader(bytes, 'darwin-x64'), /Wrong Mach-O architecture/);
  const file = join(scratch(t), 'fake');
  writeFileSync(file, bytes); chmodSync(file, 0o755);
  assert.throws(() => verifyNativeImage(file, 'darwin-arm64'), /no load commands/);
  bytes.writeUInt32LE(8, 12);
  verifyNativeHeader(bytes, 'darwin-arm64', true);
  assert.throws(() => verifyNativeHeader(bytes, 'darwin-arm64'), /Wrong Mach-O/);
  writeFileSync(file, bytes);
  assert.throws(() => verifyNativeImage(file, 'darwin-arm64', true), /no load commands/);
});

test('native recipes preserve upstream platform differences', () => {
  assert.ok(configureFlags('linux-x64-glibc', '/build/tarballs', 8).includes('--disable-gui'));
  assert.ok(configureFlags('linux-x64-glibc', '/build/tarballs', 8).includes('--without-gssapi'));
  assert.ok(configureFlags('linux-arm64-glibc', '/build/tarballs', 8).includes('--without-x'));
  assert.ok(configureFlags('linux-arm64-glibc', '/build/tarballs', 8).includes('--without-gssapi'));
  assert.ok(!configureFlags('darwin-arm64', '/build/tarballs', 8).includes('--disable-gui'));
  assert.ok(!configureFlags('darwin-arm64', '/build/tarballs', 8).includes('--disable-skia'));
  assert.ok(!configureFlags('win32-arm64', '/build/tarballs', 8).includes('--disable-gui'));
});

test('native conversion builds omit desktop content and interactive document services', () => {
  for (const { prebuild } of packageMatrix().filter(row => row.prebuild.platform !== 'wasm')) {
    const flags = configureFlags(prebuild.platform, '/build/tarballs', 8);
    for (const component of ['extensions', 'database-connectivity', 'scripting', 'sdremote', 'sdremote-bluetooth', 'ldap'])
      assert.ok(flags.includes(`--disable-${component}`), `${prebuild.platform} must omit ${component}`);
    for (const content of ['galleries', 'templates', 'theme'])
      assert.ok(flags.includes(`--with-${content}=no`), `${prebuild.platform} must omit desktop ${content}`);
  }
});

test('configure receipts reject stale or overridden components while allowing builder resource paths', () => {
  for (const { prebuild } of packageMatrix().filter(row => row.prebuild.platform !== 'wasm')) {
    const platform = prebuild.platform;
    const flags = configureFlags(platform, '/different/cache', 4);
    assert.doesNotThrow(() => verifyConfigureInput(platform, flags));
    assert.throws(() => verifyConfigureInput(platform, flags.filter(flag => flag !== '--disable-scripting')), /rebuild Core/);
    assert.throws(() => verifyConfigureInput(platform, flags.filter(flag => flag !== '--disable-ldap')), /rebuild Core/);
    assert.throws(() => verifyConfigureInput(platform, [...flags, '--enable-scripting']), /rebuild Core/);
    if (platform.startsWith('win32-')) assert.doesNotThrow(() => verifyConfigureInput(platform, configureFlags(platform, '/cache', 8, '2026')));
  }
  assert.throws(() => verifyConfigureInput('darwin-arm64', null), /argument strings/);
  assert.throws(() => configureFlags('win32-x64', '/cache', 8, '2019'), /2022 or 2026/);
});
