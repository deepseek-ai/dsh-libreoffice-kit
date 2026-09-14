import assert from 'node:assert/strict';
import test from 'node:test';
import { pnpmInvocation } from '../scripts/pack-utils.mjs';

test('adapter builds pass Windows paths and arguments directly to the pnpm JavaScript entry', () => {
  const entry = 'C:\\Program Files\\pnpm\\pnpm.cjs';
  const args = ['pack', '--pack-destination', 'C:\\candidate & review'];
  assert.deepEqual(pnpmInvocation(args, { npm_execpath: entry }, 'win32'), { command: process.execPath, args: [entry, ...args] });
  assert.deepEqual(pnpmInvocation(args, { npm_execpath: 'C:\\pnpm.exe' }, 'win32'), { command: 'C:\\pnpm.exe', args });
  assert.throws(() => pnpmInvocation(args, { npm_execpath: 'C:\\pnpm.cmd' }, 'win32'), /through pnpm run/);
  assert.deepEqual(pnpmInvocation(args, {}, 'linux'), { command: 'pnpm', args });
});
