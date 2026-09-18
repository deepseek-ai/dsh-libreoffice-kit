import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { configureFlags, verifyConfigureInput } from '../engine/native/configure.mjs';
import { root } from '../scripts/platform-matrix.mjs';

test('native compiler caching is explicit and preserves the accepted component recipe', () => {
  for (const platform of ['darwin-arm64', 'linux-x64-glibc', 'win32-x64']) {
    const ordinary = configureFlags(platform, '/downloads', '2');
    const cached = configureFlags(platform, '/downloads', '8', '2022', false, 'ccache');
    assert.ok(ordinary.includes('--disable-ccache'));
    assert.ok(cached.includes('--enable-ccache'));
    assert.doesNotThrow(() => verifyConfigureInput(platform, cached));
    assert.throws(() => verifyConfigureInput(platform, [...cached, '--disable-ccache']), /differs/);
    assert.throws(() => verifyConfigureInput(platform, cached.filter(flag => flag !== '--enable-pdfium')), /differs/);
    assert.throws(() => verifyConfigureInput(platform, cached.map(flag => flag === '--enable-ccache' ? '--enable-ccache=nodepend' : flag)), /differs/);
  }
  assert.throws(() => configureFlags('darwin-arm64', '', '2', '2022', false, 'unknown'), /Compiler cache/);
});

test('cached compiler dependencies resolve when Make runs outside the source directory', t => {
  if (process.platform === 'win32') return t.skip('Windows Core builds do not use ccache');
  const compiler = process.platform === 'darwin' ? 'clang' : 'cc';
  const make = process.platform === 'darwin' ? 'gmake' : 'make';
  for (const command of ['ccache', compiler, make]) {
    if (spawnSync(command, ['--version'], { stdio: 'ignore' }).status !== 0)
      return t.skip(`${command} is required for the compiler-cache integration check`);
  }
  // macOS aliases /tmp to /private/tmp; Core's source and build paths are canonical.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'kit-ccache-deps-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const source = join(workspace, '.build/core');
  const build = join(workspace, '.build/native');
  mkdirSync(join(source, 'solenv/bin'), { recursive: true });
  mkdirSync(build, { recursive: true });
  const input = join(source, 'solenv/bin/concat-deps.c');
  const object = join(build, 'concat-deps.o');
  const dependencies = join(build, 'concat-deps.d');
  writeFileSync(input, 'int main(void) { return 0; }\n');
  const config = join(workspace, 'ccache.conf');
  writeFileSync(config, '');
  const workflow = yaml.load(readFileSync(join(root, '.github/workflows/libreoffice-kit-build-native.yml'), 'utf8'));
  const base = workflow.jobs.build.env.CCACHE_BASEDIR;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CCACHE_')));
  Object.assign(env, { CCACHE_DIR: join(workspace, 'cache'), CCACHE_CONFIGPATH: config,
    CCACHE_BASEDIR: base === undefined ? '' : base.replace('${{ github.workspace }}', workspace) });
  const compiled = spawnSync('ccache', [compiler, '-c', input, '-o', object, '-MMD', '-MF', dependencies, '-MT', object],
    { cwd: source, env, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  const checked = spawnSync(make, ['-f', dependencies, object], { cwd: build, encoding: 'utf8' });
  assert.equal(checked.status, 0, `${checked.stderr}\n${readFileSync(dependencies, 'utf8')}`);
});
