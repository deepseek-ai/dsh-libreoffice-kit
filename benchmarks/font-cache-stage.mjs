/** Stage two built adapters against the same installed engine and dependency tree. */
import { cp, mkdir, symlink, readFile, realpath } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { reversionEngine } from '../scripts/reversion-engine.mjs';
const { values } = parseArgs({ options: { baseline: { type: 'string' }, candidate: { type: 'string' }, dependencies: { type: 'string' }, output: { type: 'string' }, 'reuse-engines': { type: 'boolean' } } });
for (const key of ['baseline', 'candidate', 'dependencies', 'output']) assert.ok(values[key], `Missing --${key}`);
await mkdir(resolve(values.output), { mode: 0o700 });
for (const variant of ['baseline', 'candidate']) {
  const directory = resolve(values.output, variant); await mkdir(directory);
  await cp(join(resolve(values[variant]), 'lib'), join(directory, 'lib'), { recursive: true });
  await cp(join(resolve(values[variant]), 'package.json'), join(directory, 'package.json'));
  if (!values['reuse-engines']) {
    await symlink(resolve(values.dependencies), join(directory, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    continue;
  }
  // Compare different package versions only when the complete engine recipe is unchanged.
  // Each adapter gets its own version identity; installed engine packages stay untouched.
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const dependencies = join(directory, 'node_modules');
  await mkdir(join(dependencies, '@deepseek-ai'), { recursive: true });
  for (const name of Object.keys(manifest.dependencies)) {
    await symlink(await realpath(join(resolve(values.dependencies), name)), join(dependencies, name), process.platform === 'win32' ? 'junction' : 'dir');
  }
  const platform = process.platform === 'linux' ? 'wasm' : `${process.platform}-${process.arch}`;
  const name = `@deepseek-ai/libreoffice-kit-${platform}`;
  const source = join(resolve(values.dependencies), name);
  const engine = join(dependencies, name);
  await cp(await realpath(source), engine, { recursive: true });
  const original = JSON.parse(await readFile(join(engine, 'package.json'), 'utf8'));
  reversionEngine(platform, engine, original.version, dirname(dirname(resolve(values[variant]))));
}
