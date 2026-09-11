/** Build pinned Core and the owned LOK worker; installation never invokes this script. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureFlags, source } from '../engine/native/configure.mjs';
import { buildHelper } from '../engine/native/build-helper.mjs';
import { windowsCoreEnvironment } from '../engine/native/core-environment.mjs';
import { hostTarget, root, targets } from './platform-matrix.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const platform = value('--platform', hostTarget());
if (!targets[platform]) throw new Error(`Unsupported build target: ${platform}`);
if (platform !== hostTarget()) throw new Error('Native builds must run on the matching OS, architecture, and libc');
const core = resolve(value('--source', join(root, '.build/core')));
const build = resolve(value('--build', join(root, '.build', `native-${platform}`)));
const tarballs = resolve(value('--tarballs', join(root, '.build/tarballs')));
const parallelism = value('--jobs', '8');
if (!/^[1-9]\d*$/.test(parallelism)) throw new Error('--jobs must be a positive integer');
function run(command, argv, cwd, env = process.env) {
  const result = spawnSync(command, argv, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}, signal ${result.signal}`);
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' });
if (revision.status !== 0 || revision.stdout.trim() !== source.revision) throw new Error(`Core must be checked out at ${source.revision}`);
for (const name of readdirSync(join(root, 'engine/native/patches')).filter((name) => name.endsWith('.patch')).sort()) {
  const patch = join(root, 'engine/native/patches', name);
  const check = (reverse) => spawnSync('git', ['apply', '--check', ...(reverse ? ['--reverse'] : []), patch], { cwd: core, stdio: 'ignore' }).status === 0;
  if (check(false)) run('git', ['apply', patch], core);
  else if (!check(true)) throw new Error(`Core source differs from ${name}`);
}
mkdirSync(build, { recursive: true });
mkdirSync(tarballs, { recursive: true });
const cygwin = process.env.LIBREOFFICE_KIT_CYGWIN ?? 'C:\\cygwin64';
const shell = process.platform === 'win32' ? join(cygwin, 'bin/bash.exe') : 'sh';
function shellPath(file) {
  if (process.platform !== 'win32') return file;
  const result = spawnSync(join(cygwin, 'bin/cygpath.exe'), ['-u', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Cygwin cygpath is required for the Windows Core build');
  return result.stdout.trim();
}
const flags = configureFlags(platform, shellPath(tarballs), parallelism);
if (process.platform === 'win32') {
  const visualStudio = process.env.LIBREOFFICE_KIT_VISUAL_STUDIO ?? '2022';
  if (!['2022', '2026'].includes(visualStudio)) throw new Error('LIBREOFFICE_KIT_VISUAL_STUDIO must be 2022 or 2026');
  flags.push(`--with-visual-studio=${visualStudio}`, '--without-lxml');
  if (platform === 'win32-arm64') flags.push(`--with-build-platform-configure-options=--with-visual-studio=${visualStudio}`);
}
if (platform.endsWith('-musl')) flags.push('--disable-xmlhelp', '--disable-poppler');
if (!args.includes('--resume')) writeFileSync(join(build, 'autogen.input'), `${flags.join('\n')}\n`);
const make = process.platform === 'darwin' ? 'gmake' : process.platform === 'win32' ? process.env.LIBREOFFICE_KIT_MAKE : 'make';
if (!make) throw new Error('LIBREOFFICE_KIT_MAKE must name the native Windows GNU Make executable');
const buildEnvironment = { ...process.env, MAKE: shellPath(make) };
if (process.platform === 'win32') {
  const compiler = spawnSync('where.exe', ['cl.exe'], { encoding: 'utf8' });
  if (compiler.status !== 0) throw new Error('Initialize the MSVC developer command environment before building');
  const pathKey = Object.keys(buildEnvironment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  // Keep MSVC's linker ahead of Cygwin's unrelated link.exe utility.
  buildEnvironment[pathKey] = [dirname(make), dirname(compiler.stdout.trim().split(/\r?\n/)[0]), join(cygwin, 'bin'), buildEnvironment[pathKey]].join(';');
}
const coreEnvironment = process.platform === 'win32'
  ? windowsCoreEnvironment(buildEnvironment, ['config_host.mk.in', 'solenv/gbuild/platform/com_MSC_class.mk'].map(file => readFileSync(join(core, file), 'utf8')).join('\n'))
  : buildEnvironment;
if (!args.includes('--resume')) run(shell, [shellPath(join(core, 'autogen.sh'))], build, coreEnvironment);
if (args.includes('--configure-only')) process.exit(0);
run(make, ['build'], build, coreEnvironment);
const executable = join(build, `libreoffice-kit${process.platform === 'win32' ? '.exe' : ''}`);
buildHelper({ platform, core, executable, cwd: build, env: buildEnvironment });
run(process.execPath, [join(root, 'scripts/stage-native.mjs'), '--platform', platform, '--source', core, '--build', build], root);
