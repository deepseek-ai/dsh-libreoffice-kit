/** Build pinned Core and the owned LOK worker; installation never invokes this script. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configureFlags, nativeBuildOptions, source, verifyConfigureInput } from '../engine/native/configure.mjs';
import { corePatchFiles } from '../engine/native/core-patches.mjs';
import { verifyBuildPlatform } from '../engine/native/build-platform.mjs';
import { buildEnvironment as identityEnvironment, buildIdentity } from '../engine/build-identity.mjs';
import { windowsCoreEnvironment } from '../engine/native/core-environment.mjs';
import { hostTarget, root, targets } from './platform-matrix.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const platform = value('--platform', hostTarget());
if (!targets[platform]) throw new Error(`Unsupported build target: ${platform}`);
const crossCompile = args.includes('--cross');
verifyBuildPlatform(platform, { crossCompile });
const core = resolve(value('--source', join(root, '.build/core')));
const build = resolve(value('--build', join(root, '.build', `native-${platform}`)));
const tarballs = resolve(value('--tarballs', join(root, '.build/tarballs')));
const parallelism = value('--jobs', '8');
if (args.includes('--lto') && args.includes('--no-lto')) throw new Error('--lto and --no-lto cannot be combined');
const clangCl = args.includes('--clang-cl');
const { optimization, lto } = nativeBuildOptions(platform, {
  optimization: value('--optimization'),
  lto: args.includes('--no-lto') ? false : args.includes('--lto') ? true : undefined,
  clangCl,
});
if (!/^[1-9]\d*$/.test(parallelism)) throw new Error('--jobs must be a positive integer');
function run(command, argv, cwd, env = process.env) {
  const result = spawnSync(command, argv, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}, signal ${result.signal}`);
}
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: core, encoding: 'utf8' });
if (revision.status !== 0 || revision.stdout.trim() !== source.revision) throw new Error(`Core must be checked out at ${source.revision}`);
for (const file of corePatchFiles()) {
  const patch = join(root, file);
  const check = (reverse) => spawnSync('git', ['apply', '--check', ...(reverse ? ['--reverse'] : []), patch], { cwd: core, stdio: 'ignore' }).status === 0;
  if (check(false)) run('git', ['apply', patch], core);
  else if (!check(true)) throw new Error(`Core source differs from ${file}`);
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
const flags = configureFlags(platform, shellPath(tarballs), parallelism, process.env.LIBREOFFICE_KIT_VISUAL_STUDIO, crossCompile, { lto });
if (args.includes('--resume')) {
  const configured = readFileSync(join(build, 'autogen.input'), 'utf8').trim().split('\n');
  verifyConfigureInput(platform, configured);
  if (configured.includes('--enable-lto') !== lto) throw new Error('Resume must use the original LTO setting (--lto or --no-lto)');
}
const make = process.platform === 'darwin' ? 'gmake' : process.platform === 'win32' ? process.env.LIBREOFFICE_KIT_MAKE : 'make';
if (!make) throw new Error('LIBREOFFICE_KIT_MAKE must name the native Windows GNU Make executable');
const identityPaths = { workspace: root, source: core, build, tarballs };
const buildEnvironment = identityEnvironment({ ...process.env, MAKE: shellPath(make) }, clangCl ? 'clang-cl' : platform, identityPaths);
if (clangCl) {
  const compiler = spawnSync('where.exe', ['clang-cl.exe'], { encoding: 'utf8' });
  if (compiler.status !== 0) throw new Error('--clang-cl requires clang-cl.exe and lld-link.exe on PATH');
  // Core's nmake/autoconf wrappers require a real path, not a PATH lookup name.
  const shortPath = spawnSync(join(cygwin, 'bin/cygpath.exe'), ['-m', '-s', compiler.stdout.trim().split(/\r?\n/)[0]], { encoding: 'utf8' });
  if (shortPath.status !== 0 || /\s/.test(shortPath.stdout.trim())) throw new Error('clang-cl requires a compiler path without spaces');
  buildEnvironment.CC = buildEnvironment.CXX = `${shortPath.stdout.trim()} -fuse-ld=lld`;
  const llvmDirectory = dirname(compiler.stdout.trim().split(/\r?\n/)[0]);
  if (!existsSync(join(llvmDirectory, 'lld-link.exe')))
    throw new Error('--clang-cl requires lld-link.exe beside clang-cl.exe');
}
if (optimization !== 'default') {
  // Explicit CFLAGS replace gbuild's default -O2 and also reach external projects.
  const flag = `${clangCl ? '/clang:' : ''}-${optimization}`;
  for (const key of ['CFLAGS', 'CXXFLAGS', 'OBJCFLAGS', 'OBJCXXFLAGS'])
    buildEnvironment[key] += ` ${flag}`;
  // External projects also append gbuild's optimization policy after CFLAGS.
  buildEnvironment.gb_COMPILEROPTFLAGS = flag;
}
if (process.platform === 'win32') {
  // UCRT's builtin offsetof supports the constant expressions required by Skia and PDFium.
  buildEnvironment.ENVCFLAGSCXX = `${buildEnvironment.ENVCFLAGSCXX ?? ''} -D_CRT_USE_BUILTIN_OFFSETOF=1`.trim();
  const compiler = spawnSync('where.exe', ['cl.exe'], { encoding: 'utf8' });
  if (compiler.status !== 0) throw new Error('Initialize the MSVC developer command environment before building');
  const pathKey = Object.keys(buildEnvironment).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  // Keep MSVC's linker ahead of Cygwin's unrelated link.exe utility.
  buildEnvironment[pathKey] = [dirname(make), dirname(compiler.stdout.trim().split(/\r?\n/)[0]), join(cygwin, 'bin'), buildEnvironment[pathKey]].join(';');
}
const identity = { ...buildIdentity(platform, identityPaths, buildEnvironment), ...(crossCompile ? { crossCompile: true } : {}), ...(clangCl ? { compiler: 'clang-cl' } : {}) };
const identityFile = join(build, 'dsh-build-identity.json');
if (args.includes('--resume') || existsSync(join(build, 'config_host.mk'))) {
  if (!existsSync(identityFile) || JSON.stringify(JSON.parse(readFileSync(identityFile, 'utf8'))) !== JSON.stringify(identity))
    throw new Error('Build identity differs; use a fresh Core build directory');
}
if (!args.includes('--resume')) writeFileSync(join(build, 'autogen.input'), `${flags.join('\n')}\n`);
const coreEnvironment = process.platform === 'win32'
  ? windowsCoreEnvironment(buildEnvironment, ['config_host.mk.in', 'solenv/gbuild/platform/com_MSC_class.mk'].map(file => readFileSync(join(core, file), 'utf8')).join('\n'))
  : buildEnvironment;
if (!args.includes('--resume')) {
  run(shell, [shellPath(join(core, 'autogen.sh'))], build, coreEnvironment);
  writeFileSync(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
}
if (args.includes('--configure-only')) process.exit(0);
{
  const worker = readFileSync(join(root, 'engine/native/worker.cxx'), 'utf8')
    .replace('"../document-operations.hxx"', '"dsh-document-operations.hxx"');
  for (const [name, contents] of [
    ['dsh_native_worker.cxx', worker],
    ['dsh-document-operations.hxx', readFileSync(join(root, 'engine/document-operations.hxx'), 'utf8')],
  ]) {
    const destination = join(core, 'desktop/source/app', name);
    if (!existsSync(destination) || readFileSync(destination, 'utf8') !== contents)
      writeFileSync(destination, contents);
  }
  run('git', ['add', '--intent-to-add', '--', 'desktop/source/app/dsh_native_worker.cxx',
    'desktop/source/app/dsh-document-operations.hxx'], core);
}
run(make, ['build', `PARALLELISM=${parallelism}`], build, coreEnvironment);
const executable = join(build, `libreoffice-kit${process.platform === 'win32' ? '.exe' : ''}`);
const config = readFileSync(join(build, 'config_host.mk'), 'utf8');
if (!/^export DISABLE_DYNLOADING=TRUE$/m.test(config)) throw new Error('Native engines require static Core linkage');
const setting = name => {
  const value = config.match(new RegExp(`^(?:export )?${name}=(.*)$`, 'm'))?.[1];
  if (!value) throw new Error(`Core build is missing ${name}`);
  return value;
};
copyFileSync(join(setting('INSTROOT'), setting('LIBO_BIN_FOLDER'),
  platform.startsWith('darwin-') ? 'soffice' : 'soffice.bin'), executable);
run(process.execPath, [join(root, 'scripts/stage-native.mjs'), '--platform', platform, '--source', core, '--build', build], root);
