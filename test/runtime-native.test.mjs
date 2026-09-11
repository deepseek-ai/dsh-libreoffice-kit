import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watch } from 'node:fs';
import { mkdtemp, cp, mkdir, symlink, realpath, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platformTarget } from '../packages/entry/src/engine.js';
import { nativeEnvironment } from '../packages/entry/src/native.js';
import { documentFixture } from './runtime-fixture.mjs';

test('native helper environment excludes credentials and inherited loader overrides', () => {
  assert.deepEqual(nativeEnvironment('/private/profile', { PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/real/home', DEEPSEEK_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture', NODE_OPTIONS: '--inspect', DYLD_INSERT_LIBRARIES: '/fixture' }), {
    PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/private/profile', USERPROFILE: '/private/profile', TMPDIR: '/private/profile', TMP: '/private/profile', TEMP: '/private/profile',
  });
});

async function readWhenCreated(path) {
  let watcher;
  let timer;
  try {
    return await new Promise((resolve, reject) => {
      const check = () => readFile(path, 'utf8').then(value => { if (value) resolve(JSON.parse(value)); }).catch(error => { if (error.code !== 'ENOENT') reject(error); });
      watcher = watch(dirname(path), check);
      watcher.once('error', reject);
      timer = setTimeout(() => reject(new Error('Native fixture did not report readiness.')), 30_000);
      check();
    });
  } finally { clearTimeout(timer); watcher?.close(); }
}

test('native cancellation waits for helper exit and cleans outputs before releasing its slot', { skip: process.platform === 'win32' || !platformTarget(), timeout: 60_000 }, async () => {
  // POSIX shebang execution substitutes a waiting helper; Windows requires a compiled executable fixture.
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-native-lifetime-'));
  let converter;
  try {
    const modules = join(root, 'node_modules');
    const namespace = join(modules, '@deepseek-ai');
    await mkdir(namespace, { recursive: true });
    const entry = join(namespace, 'libreoffice-kit');
    const source = fileURLToPath(new URL('../packages/entry', import.meta.url));
    await cp(source, entry, { recursive: true, filter: path => !path.includes('/node_modules') });
    for (const dependency of ['fflate', 'fontkit', 'saxes']) await symlink(await realpath(join(source, 'node_modules', dependency)), join(modules, dependency));
    const native = join(namespace, `libreoffice-kit-${platformTarget()}`);
    await mkdir(join(native, 'program'), { recursive: true });
    await writeFile(join(native, 'package.json'), JSON.stringify({ version: '0.1.0', exports: { './package.json': './package.json' } }));
    await writeFile(join(native, 'prebuilds.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.0', platform: platformTarget(), status: 'built', engine: { kind: 'native', executable: 'helper', programDirectory: 'program' } }));
    const marker = join(root, 'started.json');
    await writeFile(join(native, 'helper'), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid }));\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const { createConverter } = await import(pathToFileURL(join(entry, 'src/index.js')).href);
    converter = await createConverter({ fontDirectories: [], timeoutMs: 30_000 });
    assert.equal(converter.backend, 'native');
    const inputPath = join(root, 'input.docx');
    const outputPath = join(root, 'output.pdf');
    await writeFile(inputPath, documentFixture());
    const controller = new AbortController();
    const active = converter.render({ inputPath, outputPath }, controller.signal);
    void active.catch(() => {});
    const { pid } = await readWhenCreated(marker);
    assert.doesNotThrow(() => process.kill(pid, 0));
    const queuedController = new AbortController();
    const queued = converter.render({ inputPath, outputPath: join(root, 'queued.pdf') }, queuedController.signal);
    const queuedCheck = assert.rejects(queued, /queued stop/);
    queuedController.abort(new Error('queued stop'));
    await queuedCheck;
    controller.abort(new Error('active stop'));
    await assert.rejects(active, /active stop/);
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
    await assert.rejects(stat(outputPath), error => error.code === 'ENOENT');
    await rm(marker);
    const secondOutput = join(root, 'dispose.pdf');
    const second = converter.render({ inputPath, outputPath: secondOutput });
    void second.catch(() => {});
    const secondPid = (await readWhenCreated(marker)).pid;
    await converter.dispose();
    await assert.rejects(second, /disposed/);
    assert.throws(() => process.kill(secondPid, 0), error => error.code === 'ESRCH');
    await assert.rejects(stat(secondOutput), error => error.code === 'ENOENT');
    const timeoutConverter = await createConverter({ fontDirectories: [], timeoutMs: 1 });
    try { await assert.rejects(timeoutConverter.render({ inputPath, outputPath: join(root, 'timeout.pdf') }), /timed out/); }
    finally { await timeoutConverter.dispose(); }
    await assert.rejects(stat(join(root, 'timeout.pdf')), error => error.code === 'ENOENT');
    await writeFile(join(native, 'helper'), `#!${process.execPath}\nconsole.log(JSON.stringify({ ok: false, error: 'fixture conversion failure' }));\nprocess.exitCode = 2;\n`, { mode: 0o700 });
    const failingConverter = await createConverter({ fontDirectories: [] });
    try { await assert.rejects(failingConverter.render({ inputPath, outputPath: join(root, 'failed.pdf') }), /fixture conversion failure/); }
    finally { await failingConverter.dispose(); }
    await assert.rejects(stat(join(root, 'failed.pdf')), error => error.code === 'ENOENT');
  } finally { await converter?.dispose(); await rm(root, { recursive: true, force: true }); }
});
