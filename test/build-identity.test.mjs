import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const key of ['CFLAGS', 'CXXFLAGS', 'ENVCFLAGS', 'ENVCFLAGSCXX']) assert.match(env[key], /-ffile-prefix-map=/);
  const identity = buildIdentity('darwin-arm64', paths, env);
  assert.doesNotMatch(JSON.stringify(identity), /private-builder|elsewhere/);
  assert.notEqual(identity.configuration, buildIdentity('darwin-arm64', paths, { ...env, CFLAGS: '-g' }).configuration);
  assert.deepEqual(publicBuildValue({ args: ['/Users/private-builder/kit/core/x.cxx'] }, paths), { args: ['/build/libreoffice-kit/source/x.cxx'] });
  assert.throws(() => buildPathFlags('wasm', { build: '/bad path' }), /metacharacters/);
  assert.match(buildPathFlags('win32-x64', { source: 'C:\\work\\core' })[0], /^\/pathmap:/);
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
