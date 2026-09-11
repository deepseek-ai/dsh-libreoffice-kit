/** Planned targets remain in CI output even before their first successful build. */
import { isMain, packageMatrix, releaseTargets, targets } from './platform-matrix.mjs';
import { verifyRelease } from './verify-release.mjs';

export function githubMatrix(args = []) {
  verifyRelease({ metadataOnly: true });
  const selection = releaseTargets(args);
  return { include: packageMatrix().filter((row) => selection.includes(row.prebuild.platform)
    && (!args.includes('--native-only') || row.prebuild.platform !== 'wasm')
    && (!args.includes('--hosted-only') || !row.prebuild.platform.startsWith('win32-'))).map((row) => ({
    platform: row.prebuild.platform, status: row.prebuild.status,
    ...(targets[row.prebuild.platform] ?? { os: 'linux', cpu: 'x64', runner: 'ubuntu-24.04' }),
  })) };
}

if (isMain(import.meta.url)) console.log(JSON.stringify(githubMatrix(process.argv.slice(2))));
