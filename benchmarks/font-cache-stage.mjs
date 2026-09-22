/** Stage two built adapters against the same installed engine and dependency tree. */
import { cp, mkdir, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const { values } = parseArgs({ options: { baseline: { type: 'string' }, candidate: { type: 'string' }, dependencies: { type: 'string' }, output: { type: 'string' } } });
for (const key of ['baseline', 'candidate', 'dependencies', 'output']) assert.ok(values[key], `Missing --${key}`);
await mkdir(resolve(values.output), { mode: 0o700 });
for (const variant of ['baseline', 'candidate']) {
  const directory = resolve(values.output, variant); await mkdir(directory);
  await cp(join(resolve(values[variant]), 'lib'), join(directory, 'lib'), { recursive: true });
  await cp(join(resolve(values[variant]), 'package.json'), join(directory, 'package.json'));
  await symlink(resolve(values.dependencies), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
}
