import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { buildEnvironment, buildIdentity, buildPathFlags, publicBuildValue } from '../engine/build-identity.mjs';

test('build mappings cover external directories and receipts retain no private paths', () => {
  const paths = { workspace: '/Users/private-builder/kit', source: '/Users/private-builder/kit/core', build: '/elsewhere/build' };
  const env = buildEnvironment({ API_KEY: 'private-test-value', CFLAGS: '-O2' }, 'darwin-arm64', paths);
  assert.equal(env.API_KEY, undefined);
  assert.ok(env.CFLAGS.startsWith('-O2 '));
  for (const key of ['CFLAGS', 'CXXFLAGS', 'OBJCFLAGS', 'OBJCXXFLAGS', 'ENVCFLAGS', 'ENVCFLAGSCXX']) assert.match(env[key], /-ffile-prefix-map=/);
  const identity = buildIdentity('darwin-arm64', paths, env);
  assert.doesNotMatch(JSON.stringify(identity), /private-builder|elsewhere/);
  assert.notEqual(identity.configuration, buildIdentity('darwin-arm64', paths, { ...env, CFLAGS: '-g' }).configuration);
  assert.notEqual(identity.configuration, buildIdentity('darwin-arm64', paths, { ...env, OBJCXXFLAGS: '-g' }).configuration);
  assert.deepEqual(publicBuildValue({ args: ['/Users/private-builder/kit/core/x.cxx'] }, paths), { args: ['/build/libreoffice-kit/source/x.cxx'] });
  assert.throws(() => buildPathFlags('wasm', { build: '/bad path' }), /metacharacters/);
  assert.deepEqual(buildPathFlags('win32-x64', { source: 'C:\\work\\core' }), ['/experimental:deterministic', '/pathmap:C:/work/core=/build/libreoffice-kit/source']);
});

test('the host compiler maps __FILE__ using the most specific source prefix', { skip: process.platform === 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'kit-prefix-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'probe.c');
  const executable = join(root, 'probe');
  writeFileSync(file, '#include <stdio.h>\nint main(void) { puts(__FILE__); }\n');
  const result = spawnSync('cc', [...buildPathFlags(process.platform, { workspace: tmpdir(), source: root }), file, '-o', executable], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync(executable, [], { encoding: 'utf8' }).stdout.trim(), '/build/libreoffice-kit/source/probe.c');
});

test('macOS Objective-C++ receives public path mappings', { skip: process.platform !== 'darwin' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'kit-objc-prefix-map-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'probe.mm');
  const executable = join(root, 'probe');
  writeFileSync(file, '#include <stdio.h>\nint main() { puts(__FILE__); }\n');
  const env = buildEnvironment({}, 'darwin-arm64', { source: root });
  const result = spawnSync('c++', [...env.OBJCXXFLAGS.split(' '), file, '-o', executable], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(spawnSync(executable, [], { encoding: 'utf8' }).stdout.trim(), '/build/libreoffice-kit/source/probe.mm');
});

test('Core prefix-map patches preserve optimization, debug policy and user overrides', { skip: process.platform === 'win32' }, () => {
  const native = readFileSync(new URL('../engine/native/patches/0008-preserve-optimization-with-prefix-maps.patch', import.meta.url), 'utf8');
  const wasm = readFileSync(new URL('../engine/wasm-source/patches/0011-preserve-optimization-with-prefix-maps.patch', import.meta.url), 'utf8');
  assert.equal(native, wasm);
  const definitions = native.split('\n').filter(line => line.startsWith('+gb_LinkTarget')).map(line => line.slice(1)).join('\n');
  for (const policy of ['-O2', '-O3', '-O0 -g']) {
    for (const override of ['', '-Os ']) {
      for (const map of ['-ffile-prefix-map=/private/build=/build/public', '/experimental:deterministic /pathmap:C:/private/build=/build/public']) {
        const makefile = [`gb_LinkTarget__get_debugflags=${policy}`, definitions,
          ...['CFLAGS', 'CXXFLAGS', 'OBJCFLAGS', 'OBJCXXFLAGS'].map(key => `${key}=${override}${map}`),
          ...['c', 'cxx', 'objc', 'objcxx'].map(lang => `$(info $(call gb_LinkTarget__get_${lang}flags,probe))`),
          'all:;@:', ''].join('\n');
        const result = spawnSync(process.platform === 'darwin' ? 'gmake' : 'make', ['--no-print-directory', '-f', '-'], { input: makefile, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.trim().split('\n'), Array(4).fill(`${override || `${policy} `}${map}`));
      }
    }
  }
});
