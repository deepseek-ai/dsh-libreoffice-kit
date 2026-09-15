import test from 'node:test';
import assert from 'node:assert/strict';
import { buildJobs } from '../scripts/ci-build-resources.mjs';

const gib = 1024 ** 3;
test('Core parallelism fits small hosted runners and scales with larger runners', () => {
  assert.equal(buildJobs('wasm', '', { cpus: 2, memory: 8 * gib }), 2);
  assert.equal(buildJobs('darwin-arm64', '', { cpus: 3, memory: 7 * gib }), 3);
  assert.equal(buildJobs('win32-x64', '', { cpus: 16, memory: 64 * gib }), 16);
  assert.equal(buildJobs('wasm', '', { cpus: 32, memory: 16 * gib }), 7);
  assert.equal(buildJobs('wasm', '', { cpus: 2, memory: gib }), 1);
});

test('explicit measured parallelism is accepted while malformed overrides fail early', () => {
  assert.equal(buildJobs('wasm', '12', { cpus: 16, memory: 64 * gib }), 12);
  for (const value of ['0', '-1', '2.5', '1e2', ' 8', '9007199254740992'])
    assert.throws(() => buildJobs('wasm', value), /positive integer/);
  assert.throws(() => buildJobs('unknown', '8'), /Unknown build platform/);
});
