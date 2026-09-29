import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCoreBuildResources } from '../scripts/verify-core-build-resources.mjs';

for (const platform of ['win32', 'darwin', 'linux']) {
  test(`${platform} refuses standard 4-vCPU Core compilation and accepts 16 vCPUs`, () => {
    assert.throws(() => verifyCoreBuildResources(platform, 4), /4-vCPU runners are forbidden/);
    assert.doesNotThrow(() => verifyCoreBuildResources(platform, 16));
  });
}

test('macOS larger runners can use fewer vCPUs than Windows builders', () => {
  assert.doesNotThrow(() => verifyCoreBuildResources('darwin', 5));
  assert.throws(() => verifyCoreBuildResources('win32', 8), /at least 16/);
});
