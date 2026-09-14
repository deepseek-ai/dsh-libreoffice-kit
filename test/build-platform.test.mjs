import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyBuildPlatform } from '../engine/native/build-platform.mjs';

test('native builds require the target host except for explicit MSVC x64 to ARM64 cross-builds', () => {
  for (const host of ['darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'])
    assert.doesNotThrow(() => verifyBuildPlatform(host, { host }));
  assert.throws(() => verifyBuildPlatform('darwin-x64', { host: 'darwin-arm64', crossCompile: true }), /matching host/);
  assert.throws(() => verifyBuildPlatform('win32-arm64', { host: 'win32-x64' }), /matching host/);
  assert.throws(() => verifyBuildPlatform('win32-arm64', { host: 'win32-x64', crossCompile: true, env: {} }), /developer environment/);
  assert.doesNotThrow(() => verifyBuildPlatform('win32-arm64', { host: 'win32-x64', crossCompile: true,
    env: { VSCMD_ARG_HOST_ARCH: 'x64', VSCMD_ARG_TGT_ARCH: 'arm64' } }));
  assert.throws(() => verifyBuildPlatform('win32-x64', { host: 'win32-arm64', crossCompile: true }), /matching host/);
});
