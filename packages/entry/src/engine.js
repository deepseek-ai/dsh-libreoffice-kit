/** Resolve installed, version-matched engine packages without downloads or compilation. */
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve, relative, sep, join } from 'node:path';

const require = createRequire(import.meta.url);

function installedPackageExists(name) {
  return (require.resolve.paths(name) ?? []).some(directory => {
    try { lstatSync(join(directory, name)); return true; } catch (error) {
      // Absent package directories permit fallback; unreadable directories are installation errors.
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  });
}

/** Return the optional package target for the current process ABI. */
export function platformTarget(platform = process.platform, arch = process.arch, report = () => process.report.getReport()) {
  if (!['arm64', 'x64'].includes(arch)) return undefined;
  if (platform === 'darwin' || platform === 'win32') return `${platform}-${arch}`;
  if (platform !== 'linux') return undefined;
  return `linux-${arch}-${report().header.glibcVersionRuntime ? 'glibc' : 'musl'}`;
}

function asset(root, value) {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new Error('Engine manifest contains an invalid asset path.');
  const path = resolve(root, value);
  if (relative(root, path).startsWith(`..${sep}`) || relative(root, path) === '..') throw new Error('Engine asset escapes its installed package.');
  return path;
}

/** Installed but incomplete packages are errors; absence alone enables WASM fallback. */
export async function resolveEngine(resolvePackage = name => require.resolve(`${name}/package.json`), packageExists = installedPackageExists) {
  const target = platformTarget();
  let packageFile;
  if (target) {
    const name = `@deepseek-ai/libreoffice-kit-${target}`;
    try { packageFile = resolvePackage(name); } catch (error) {
      // Only failure to find this package permits fallback; broken exports are installation failures.
      if (error?.code !== 'MODULE_NOT_FOUND' || !error.message.includes(`${name}/package.json`)) throw error;
      if (packageExists(name)) throw new Error(`Installed LibreOfficeKit package is incomplete: ${name}`, { cause: error });
    }
  }
  const backend = packageFile ? 'native' : 'wasm';
  packageFile ??= resolvePackage('@deepseek-ai/libreoffice-kit-wasm');
  const root = dirname(packageFile);
  const [pkg, manifest] = await Promise.all([readFile(packageFile, 'utf8').then(JSON.parse), readFile(resolve(root, 'prebuilds.json'), 'utf8').then(JSON.parse)]);
  if (pkg.version !== '0.1.0' || manifest.version !== pkg.version || manifest.schemaVersion !== 1 || manifest.status !== 'built'
    || manifest.engine?.kind !== backend || manifest.platform !== (backend === 'native' ? target : 'wasm')) throw new Error(`Installed LibreOfficeKit ${backend} package has an incompatible or incomplete manifest.`);
  const engine = { backend, root, programDirectory: manifest.engine.programDirectory };
  const fields = backend === 'native' ? ['executable', 'programDirectory'] : ['loader', 'wasm', 'data', 'metadata'];
  for (const name of fields) {
    engine[name] = asset(root, manifest.engine[name]);
    const status = await stat(engine[name]);
    if (name === 'programDirectory' ? !status.isDirectory() : !status.isFile()) throw new Error(`Installed LibreOfficeKit ${name} is not a ${name === 'programDirectory' ? 'directory' : 'file'}.`);
    if (name === 'executable' && process.platform !== 'win32' && !(status.mode & 0o111)) throw new Error('Installed LibreOfficeKit executable is not executable.');
  }
  return engine;
}
