/** Package metadata shared by release tooling; runtime selection belongs to the entry. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const entryName = '@deepseek-ai/libreoffice-kit';
export const wasmName = `${entryName}-wasm`;
export const nodeRange = '>=22.19.0';
export const targets = Object.freeze({
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', runner: 'macos-15' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', runner: 'macos-15-intel' },
  'linux-arm64-glibc': { os: 'linux', cpu: 'arm64', libc: 'glibc', runner: 'ubuntu-24.04-arm' },
  'linux-arm64-musl': { os: 'linux', cpu: 'arm64', libc: 'musl', runner: 'ubuntu-24.04-arm', buildContainer: 'node:22.19.0-alpine3.22' },
  'linux-x64-glibc': { os: 'linux', cpu: 'x64', libc: 'glibc', runner: 'ubuntu-24.04' },
  'linux-x64-musl': { os: 'linux', cpu: 'x64', libc: 'musl', runner: 'ubuntu-24.04', buildContainer: 'node:22.19.0-alpine3.22' },
  'win32-arm64': { os: 'win32', cpu: 'arm64', runner: 'windows-11-arm' },
  'win32-x64': { os: 'win32', cpu: 'x64', runner: 'windows-2022' },
});

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Return the complete declared matrix, including targets without built assets. */
export function packageMatrix(repo = root) {
  return readdirSync(join(repo, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'entry')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const dir = join(repo, 'packages', entry.name);
      return { dir, manifest: readJson(join(dir, 'package.json')), prebuild: readJson(join(dir, 'prebuilds.json')) };
    });
}

/** An unrecognized Linux libc is deliberately not treated as glibc. */
export function hostTarget(platform = process.platform, arch = process.arch, report = process.report?.getReport()) {
  if (platform !== 'linux') return Object.hasOwn(targets, `${platform}-${arch}`) ? `${platform}-${arch}` : undefined;
  const libc = report?.header?.glibcVersionRuntime ? 'glibc'
    : report?.sharedObjects?.some((file) => /(?:^|\/)ld-musl-[^/]+\.so\.1$|(?:^|\/)libc\.musl-[^/]+\.so\.1$/.test(file)) ? 'musl' : undefined;
  const candidate = `${platform}-${arch}-${libc}`;
  return Object.hasOwn(targets, candidate) ? candidate : undefined;
}

/** Explicit scopes never silently drop an unbuilt native target. */
export function releaseTargets(args) {
  const wasmOnly = args.includes('--wasm-only');
  const index = args.indexOf('--platform');
  if (wasmOnly && index !== -1) throw new Error('--wasm-only and --platform are mutually exclusive');
  if (index !== -1) {
    const platform = args[index + 1];
    if (!Object.hasOwn(targets, platform)) throw new Error(`Unknown native platform: ${platform}`);
    return [platform, 'wasm'];
  }
  return wasmOnly ? ['wasm'] : [...Object.keys(targets), 'wasm'];
}

export function tarballName(manifest) {
  return `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
}

export function isMain(url) {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url);
}
