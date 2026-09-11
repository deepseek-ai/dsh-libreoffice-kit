import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveEngine } from '../packages/entry/src/engine.js';

async function fixture(t, minimum = '2.38') {
  const directory = await mkdtemp(join(tmpdir(), 'libreoffice-glibc-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const native = join(directory, 'native');
  const wasm = join(directory, 'wasm');
  await mkdir(join(native, 'program'), { recursive: true });
  await mkdir(wasm);
  await writeFile(join(native, 'helper'), 'fixture', { mode: 0o755 });
  const nativeName = '@deepseek-ai/libreoffice-kit-linux-arm64-glibc';
  const manifest = { schemaVersion: 1, version: '0.1.0', platform: 'linux-arm64-glibc', status: 'built', engine: {
    kind: 'native', executable: 'helper', programDirectory: 'program', glibcMinimum: minimum,
  } };
  const writeNative = () => writeFile(join(native, 'prebuilds.json'), JSON.stringify(manifest));
  await writeNative();
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: nativeName, version: '0.1.0' }));
  await writeFile(join(wasm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.1.0' }));
  for (const file of ['loader', 'wasm', 'data', 'metadata']) await writeFile(join(wasm, file), 'fixture');
  await writeFile(join(wasm, 'prebuilds.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', platform: 'wasm', status: 'built', engine: {
    kind: 'wasm', loader: 'loader', wasm: 'wasm', data: 'data', metadata: 'metadata', programDirectory: '/instdir/program',
  } }));
  const resolutions = [];
  const resolve = report => resolveEngine(name => {
    resolutions.push(name);
    assert.ok([nativeName, '@deepseek-ai/libreoffice-kit-wasm'].includes(name));
    return join(name === nativeName ? native : wasm, 'package.json');
  }, () => true, { platform: 'linux', arch: 'arm64', report: () => report });
  return { directory, native, wasm, manifest, writeNative, resolutions, resolve };
}

test('known older glibc selects the required WASM, while equal and newer hosts use native', async t => {
  const { resolve, resolutions } = await fixture(t);
  for (const version of ['2.17', '2.9', '2.37.9', '2.38', '2.39', '3.0']) {
    const expected = ['2.17', '2.9', '2.37.9'].includes(version) ? 'wasm' : 'native';
    assert.equal((await resolve({ header: { glibcVersionRuntime: version } })).backend, expected);
  }
  assert.equal(resolutions.filter(name => name.endsWith('-wasm')).length, 3);
});

test('older manifests remain readable and unknown libc does not select a native ABI', async t => {
  const { resolve, manifest, writeNative } = await fixture(t);
  delete manifest.engine.glibcMinimum;
  await writeNative();
  assert.equal((await resolve({ header: { glibcVersionRuntime: '2.17' } })).backend, 'native');
  assert.equal((await resolve({ header: {}, sharedObjects: ['/lib/libc.so.6'] })).backend, 'wasm');
});

test('glibc patch versions compare numerically with an omitted patch component equal to zero', async t => {
  const { resolve } = await fixture(t, '2.2.5');
  assert.equal((await resolve({ header: { glibcVersionRuntime: '2.2' } })).backend, 'wasm');
  assert.equal((await resolve({ header: { glibcVersionRuntime: '2.2.5' } })).backend, 'native');
  assert.equal((await resolve({ header: { glibcVersionRuntime: '2.10' } })).backend, 'native');
});

test('invalid glibc metadata rejects before considering fallback', async t => {
  const { resolve, manifest, writeNative, resolutions } = await fixture(t);
  for (const value of [null, 2.38, '', '2', '2.38.0.1', '02.38', '2.38 ', 'GLIBC_2.38', '9007199254740992.1']) {
    manifest.engine.glibcMinimum = value;
    await writeNative();
    await assert.rejects(resolve({ header: { glibcVersionRuntime: '2.17' } }), /invalid glibcMinimum/);
  }
  assert.equal(resolutions.filter(name => name.endsWith('-wasm')).length, 0);
});

test('a mismatched package identity or missing native asset rejects even on older glibc', async t => {
  const { resolve, native, resolutions } = await fixture(t);
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-linux-x64-glibc', version: '0.1.0' }));
  await assert.rejects(resolve({ header: { glibcVersionRuntime: '2.17' } }), /incompatible or incomplete/);
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-linux-arm64-glibc', version: '0.1.0' }));
  await rm(join(native, 'helper'));
  await assert.rejects(resolve({ header: { glibcVersionRuntime: '2.17' } }), { code: 'ENOENT' });
  assert.equal(resolutions.filter(name => name.endsWith('-wasm')).length, 0);
});

test('an unsupported native floor still requires a valid WASM installation', async t => {
  const { resolve, wasm } = await fixture(t);
  await rm(join(wasm, 'data'));
  await assert.rejects(resolve({ header: { glibcVersionRuntime: '2.17' } }), { code: 'ENOENT' });
});
