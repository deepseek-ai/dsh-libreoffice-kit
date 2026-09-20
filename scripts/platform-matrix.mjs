/** Package metadata shared by release tooling; runtime selection belongs to the adapter package. */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const enginePrefix = '@deepseek-ai/libreoffice-kit';
/** Internal repository hosting qualified engine archives for application builds. */
export const releaseRepository = 'deepseek-harness/libreoffice-kit';
/** Repository maintaining the source and Actions builds referenced by release evidence. */
export const sourceRepository = releaseRepository;
export const wasmName = `${enginePrefix}-wasm`;
export const kitPackageName = '@deepseek-ai/libreoffice-kit';
export const nodeRange = '>=22.19.0';
export const targets = Object.freeze({
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', runner: 'macos-15' },
  'darwin-x64': { os: 'darwin', cpu: 'x64', runner: 'macos-15-intel' },
  'linux-arm64-glibc': { os: 'linux', cpu: 'arm64', libc: 'glibc', runner: 'ubuntu-24.04-arm' },
  'linux-x64-glibc': { os: 'linux', cpu: 'x64', libc: 'glibc', runner: 'ubuntu-24.04' },
  'win32-arm64': { os: 'win32', cpu: 'arm64', runner: 'windows-11-arm' },
  'win32-x64': { os: 'win32', cpu: 'x64', runner: 'windows-2022' },
});

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** The adapter package directory in this checkout; it declares this family's released engine targets. */
export function kitDirectory(repo = root) {
  return join(repo, 'packages/entry');
}

/** The adapter package manifest that declares this family's released engine targets. */
export function kitManifest(repo = root) {
  return readJson(join(kitDirectory(repo), 'package.json'));
}

/** Release tags identify this standalone kit family. */
export function releaseTag(version) {
  return `libreoffice-kit-v${version}`;
}

/**
 * Versioned download URL for one engine archive attached to the family release.
 * @param version - Engine family version.
 * @param file - Release asset file name.
 * @returns the asset URL, requiring authenticated build-time preparation for internal releases.
 */
export function releaseAssetUrl(version, file) {
  return `https://github.com/${releaseRepository}/releases/download/${releaseTag(version)}/${encodeURIComponent(file)}`;
}

/** Return the complete declared matrix, including targets without built assets. */
export function packageMatrix(repo = root) {
  return readdirSync(join(repo, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !['entry', 'browser', 'fonts'].includes(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const dir = join(repo, 'packages', entry.name);
      return { dir, manifest: readJson(join(dir, 'package.json')), prebuild: readJson(join(dir, 'prebuilds.json')) };
    });
}

/** An unrecognized Linux libc is deliberately not treated as glibc. */
export function hostTarget(platform = process.platform, arch = process.arch, report = process.report?.getReport()) {
  if (platform !== 'linux') return Object.hasOwn(targets, `${platform}-${arch}`) ? `${platform}-${arch}` : undefined;
  if (!report?.header?.glibcVersionRuntime) return undefined;
  const candidate = `${platform}-${arch}-glibc`;
  return Object.hasOwn(targets, candidate) ? candidate : undefined;
}

/** The adapter declares released native packages; targets also contains unfinished build recipes. */
export function kitNativeTargets(manifest) {
  return Object.keys(manifest.optionalDependencies ?? {}).filter(name => name !== wasmName).map((name) => {
    const platform = name.slice(enginePrefix.length + 1);
    if (!name.startsWith(`${enginePrefix}-`) || !Object.hasOwn(targets, platform)) throw new Error(`Unknown native optional dependency: ${name}`);
    return platform;
  });
}

/** Explicit development scopes may select a build recipe; defaults use the adapter's release declaration. */
export function releaseTargets(args, nativeTargets = kitNativeTargets(kitManifest())) {
  const wasmOnly = args.includes('--wasm-only');
  const index = args.indexOf('--platform');
  if (wasmOnly && index !== -1) throw new Error('--wasm-only and --platform are mutually exclusive');
  if (index !== -1) {
    const platform = args[index + 1];
    if (!Object.hasOwn(targets, platform)) throw new Error(`Unknown native platform: ${platform}`);
    return [platform, 'wasm'];
  }
  return wasmOnly ? ['wasm'] : [...nativeTargets, 'wasm'];
}

export function tarballName(manifest) {
  return `${manifest.name.replace(/^@/, '').replace('/', '-')}-${manifest.version}.tgz`;
}

export function isMain(url) {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(url);
}
