/** Prepare internal Release engines; CI can explicitly build source when read access is unconfigured. */
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { corePatchFiles } from '../engine/native/core-patches.mjs';
import { verifyConfigureInput } from '../engine/native/configure.mjs';
import { readCoreSource } from '../engine/core-source.mjs';
import { enginePrefix, isMain, kitManifest, kitNativeTargets, readJson, releaseAssetUrl, releaseRepository, releaseTag, root, targets } from './platform-matrix.mjs';
import { assert, regularFile, sha256, verifyEnginePackage } from './verify-artifacts.mjs';
import { run } from './pack-utils.mjs';
import { fetchReleaseAsset } from './github-release-fetch.mjs';
import { materializeEngineArchive, verifyEngineArchiveRecord } from './engine-archive.mjs';

const runtimeTargets = {
  'node24-linux-x64': 'linux-x64-glibc',
  'node24-linux-arm64': 'linux-arm64-glibc',
  'node24-macos-arm64': 'darwin-arm64',
  'node24-macos-x64': 'darwin-x64',
  'node24-win-arm64': 'win32-arm64',
  'node24-win-x64': 'win32-x64',
};
const payloadRoots = ['assets', 'bin', 'program', 'sources', 'licenses'];

/** Select only native engines the installed adapter declares; every target requires WASM. */
export function artifactPlan(selection = '', repo = root) {
  const selected = selection ? selection.split(',').map(value => value.trim()) : Object.keys(runtimeTargets);
  assert(selected.length > 0 && selected.every(value => Object.hasOwn(runtimeTargets, value)), 'Unknown or empty Office runtime target');
  const released = kitNativeTargets(kitManifest(repo));
  return [...new Set(selected.map(value => runtimeTargets[value]).filter(value => released.includes(value))), 'wasm'];
}

/** Reject different source pins, helpers or patches even when an engine reuses the package version. */
export function verifyPreparedEngine(platform, directory = join(root, 'packages', platform), repo = root) {
  const version = readJson(join(repo, 'package.json')).version;
  const manifest = readJson(regularFile(directory, 'package.json'));
  assert(manifest.name === `${enginePrefix}-${platform}` && manifest.version === version, 'Prepared engine package/version mismatch');
  const result = verifyEnginePackage(directory);
  assert(result.platform === platform, 'Prepared engine platform mismatch');
  const prebuild = readJson(join(directory, 'prebuilds.json'));
  const wasm = platform === 'wasm';
  if (!wasm) verifyConfigureInput(platform, readJson(regularFile(directory, 'sources/core.json')).configure);
  const pinned = readCoreSource(repo);
  assert(prebuild.source.repository === pinned.repository && prebuild.source.revision === pinned.revision, 'Prepared engine upstream revision mismatch');
  const receipt = readJson(regularFile(directory, 'sources/core-source.json'));
  assert(receipt.repository === pinned.repository && receipt.revision === pinned.revision, 'Prepared engine Core source receipt mismatch');
  const files = ['engine/build-identity.mjs', ...(wasm
    ? ['engine/core-source.mjs', ...['source.json', 'source.mjs', 'autogen.input', 'lok.cxx', 'build.mjs', 'stage.mjs', 'slim.mjs', ...readdirSync(join(repo, 'engine/wasm-source/patches')).map(file => `patches/${file}`)].map(file => `engine/wasm-source/${file}`)]
    : ['engine/core-source.mjs', 'engine/native/worker.cxx', 'engine/native/configure.mjs', 'engine/native/core-patches.mjs', 'scripts/stage-native.mjs', 'scripts/slim-native.mjs', ...corePatchFiles(repo)])];
  const patchPrefix = wasm ? 'engine/wasm-source/patches/' : 'engine/native/patches/';
  const expectedPatches = files.filter(file => file.startsWith(patchPrefix)).map(file => `sources/${file}`).sort();
  const packagedPatches = prebuild.source.files.filter(file => file.startsWith(`sources/${patchPrefix}`)).sort();
  assert(JSON.stringify(packagedPatches) === JSON.stringify(expectedPatches), 'Prepared engine patch set differs; publish a new kit version');
  for (const file of files) {
    const local = join(repo, file);
    assert(sha256(regularFile(directory, `sources/${file}`)) === sha256(local), `Prepared engine source differs: ${file}; publish a new kit version`);
  }
  return result;
}

/** Download and verify with build-time GitHub authentication and no install hooks. Returns false only for an index 404. */
export async function fetchPrebuilt(platform, { repo = root, fetchImpl = fetchReleaseAsset } = {}) {
  assert(platform === 'wasm' || Object.hasOwn(targets, platform), 'Unknown engine platform');
  const destination = join(repo, 'packages', platform);
  const manifest = readJson(join(destination, 'package.json'));
  const response = await fetchImpl(releaseAssetUrl(manifest.version, 'artifact-manifest.json'), { signal: AbortSignal.timeout(60_000) });
  if (response.status === 404) { await response.body?.cancel(); return false; }
  assert(response.ok, `GitHub Release index request failed: HTTP ${response.status}`);
  const metadata = await response.json();
  assert(metadata.repository === releaseRepository && metadata.tag === releaseTag(manifest.version) && metadata.version === manifest.version,
    'GitHub Release repository/tag/version mismatch');
  const records = metadata.packages?.filter(record => record.name === manifest.name);
  assert(records?.length === 1, 'GitHub Release index must name the engine exactly once');
  const record = records[0];
  assert(record.platform === platform && record.version === manifest.version, 'GitHub Release engine platform/version mismatch');
  verifyEngineArchiveRecord(record);
  assert(typeof record.sha256 === 'string' && /^[a-f0-9]{64}$/.test(record.sha256), 'Engine tarball requires SHA-256 integrity');
  assert(Number.isSafeInteger(record.bytes) && record.bytes > 0, 'Engine tarball requires its byte count');
  const work = mkdtempSync(join(tmpdir(), 'libreoffice-prebuilt-'));
  try {
    const download = await fetchImpl(releaseAssetUrl(manifest.version, record.file), { signal: AbortSignal.timeout(900_000) });
    assert(download.ok && download.body, `GitHub Release tarball request failed: HTTP ${download.status}`);
    const hash = createHash('sha256');
    let downloadedBytes = 0;
    const archive = join(work, record.file);
    await pipeline(Readable.fromWeb(download.body), new Transform({
      transform(chunk, encoding, callback) { downloadedBytes += chunk.length; hash.update(chunk); callback(null, chunk); },
    }), createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    assert(downloadedBytes === record.bytes && hash.digest('hex') === record.sha256, 'Engine tarball integrity mismatch');
    const install = materializeEngineArchive(work, record, join(work, 'install'));
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    run('tar', ['-xf', install, '-C', unpacked], { timeout: 900_000 });
    const engine = join(unpacked, 'package');
    verifyPreparedEngine(platform, engine, repo);
    // Keep the workspace's manifest and docs; only engine payload is replaced.
    for (const part of payloadRoots) {
      rmSync(join(destination, part), { recursive: true, force: true });
      if (existsSync(join(engine, part))) cpSync(join(engine, part), join(destination, part), { recursive: true });
    }
    copyFileSync(join(engine, 'prebuilds.json'), join(destination, 'prebuilds.json'));
    return true;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const [command, value] = args;
  if (command === '--plan') console.log(JSON.stringify(artifactPlan(value)));
  else if (command === '--verify') {
    for (const platform of artifactPlan(value)) console.log(JSON.stringify(verifyPreparedEngine(platform)));
  } else {
    assert(command === 'wasm' || Object.hasOwn(targets, command), 'Unknown engine platform');
    const unconfigured = args.includes('--build-if-unconfigured') && !process.env.LIBREOFFICE_KIT_GITHUB_TOKEN;
    const found = unconfigured ? false : await fetchPrebuilt(command);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `found=${found}\n`);
    console.log(found ? `Verified GitHub Release engine: ${command}` : unconfigured
      ? `Internal release access is not configured: build ${command} from the pinned recipe`
      : `GitHub Release index returned 404: build ${command} from the pinned recipe`);
  }
}
