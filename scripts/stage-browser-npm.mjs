/** Stage the exact main/WASM Release archives; compilation and npm approval are separate. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { auditBytes, auditNpmArchive } from './publication-privacy.mjs';
import { publishNpmPackages, npmRegistry } from './publish-npm-release.mjs';
import { verifyNpmOidc } from './verify-npm-oidc.mjs';
import { verifyReleaseSourceTag } from './release-source-tag.mjs';
import { isMain, readJson, sourceRepository, tarballName } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';
import { verifyPreviewRuntime } from './verify-preview-runtime.mjs';

function versionForTag(tag) {
  const match = /^(?:libreoffice-kit-)?v(\d+\.\d+\.\d+-[\w.-]+)$/.exec(tag ?? '');
  assert(match, 'Browser staging requires a browser prerelease source tag');
  return match[1];
}

function gh(args) {
  return spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15 * 60 * 1000 });
}

/** Bind public installable archives to clean source and complete installed-preview evidence. */
export function validateBrowserNpmCandidate(directory, tag) {
  const version = versionForTag(tag);
  const candidate = readJson(join(directory, 'browser-preview.json'));
  const receipt = readJson(join(directory, 'preview-runtime.json'));
  assert(candidate.schemaVersion === 1 && candidate.kind === 'browser-preview'
    && /^[a-f0-9]{40}$/.test(candidate.sourceCommit) && candidate.sourceDirty === false,
  'Browser npm staging requires a clean source identity');
  assert(JSON.stringify(Object.keys(candidate.packages ?? {}).sort()) === '["kit","wasm"]',
    'Browser npm staging requires only the existing main and WASM packages');
  verifyPreviewRuntime(receipt, { sourceCommit: candidate.sourceCommit,
    kitSha256: candidate.packages.kit?.sha256, wasmSha256: candidate.packages.wasm?.sha256 });
  for (const name of ['browser-preview.json', 'preview-runtime.json']) auditBytes(readFileSync(join(directory, name)), name);
  const packages = ['wasm', 'kit'].map(kind => {
    const record = candidate.packages[kind];
    assert(record?.name === (kind === 'kit' ? '@deepseek-ai/libreoffice-kit' : '@deepseek-ai/libreoffice-kit-wasm') && record.version === version
      && record.file === tarballName(record) && /^[a-f0-9]{64}$/.test(record.sha256), 'Invalid browser npm archive identity');
    const path = join(directory, record.file);
    const stat = statSync(path);
    assert(stat.isFile() && Number.isSafeInteger(record.bytes) && record.bytes > 0 && stat.size === record.bytes
      && sha256(path) === record.sha256, `Browser npm archive checksum differs: ${kind}`);
    assert(receipt[kind === 'kit' ? 'archiveSha256' : 'wasmSha256'] === record.sha256,
      `Browser npm archive differs from qualification: ${kind}`);
    const { manifest } = auditNpmArchive(path);
    const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    assert(manifest.name === record.name && manifest.version === version && manifest.private !== true
      && manifest.publishConfig?.access === 'public', 'Browser npm package must permit public publication');
    assert(manifest.publishConfig.registry === undefined
      || [npmRegistry, npmRegistry.slice(0, -1)].includes(manifest.publishConfig.registry), 'Unexpected browser npm registry');
    assert(typeof repository === 'string' && repository.replace(/^git\+/, '').replace(/\.git\/?$/, '').replace(/\/$/, '')
      === `https://github.com/${sourceRepository}`, 'Browser npm package repository differs');
    assert(manifest.os === undefined && manifest.cpu === undefined && manifest.libc === undefined,
      'Kit packages must install on every supported host');
    const engineNames = Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.peerDependencies })
      .filter(name => name.startsWith('@deepseek-ai/libreoffice-kit'));
    assert(kind === 'kit'
      ? JSON.stringify(engineNames) === '["@deepseek-ai/libreoffice-kit-wasm"]'
        && manifest.dependencies?.['@deepseek-ai/libreoffice-kit-wasm'] === version
        && !Object.keys(manifest.optionalDependencies ?? {}).length
        && !Object.keys(manifest.peerDependencies ?? {}).length
      : engineNames.length === 0, 'The main API requires only its exact WASM dependency');
    return { name: record.name, version, path, integrity: `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}` };
  });
  return { sourceCommit: candidate.sourceCommit, version, packages };
}

/** The staging job consumes only receipts from its own completed OS matrix. */
export function validateCliReceipts(directory, candidate) {
  const files = readdirSync(directory);
  for (const platform of ['darwin', 'linux', 'win32']) {
    const names = files.filter(name => new RegExp(`^cli-${platform}-(?:arm64|x64)\\.json$`).test(name));
    assert(names.length === 1, `Missing or duplicate installed CLI receipt: ${platform}`);
    const receipt = readJson(join(directory, names[0]));
    assert(receipt.schemaVersion === 1 && receipt.kind === 'installed-cli' && receipt.passed === true
      && receipt.platform === platform && names[0] === `cli-${platform}-${receipt.arch}.json`
      && receipt.sourceCommit === candidate.sourceCommit
      && receipt.archiveSha256 === candidate.packages.kit.sha256 && receipt.wasmSha256 === candidate.packages.wasm.sha256
      && receipt.installedOutsideRepository === true && receipt.npmOffline === true && receipt.nativeEngines === false,
    `CLI receipt does not qualify the released archives: ${platform}`);
    for (const format of ['docx', 'xlsx', 'pptx', 'pdf']) {
      const result = receipt.formats?.[format];
      assert(result?.rasterEngine === (format === 'pdf' ? 'pdfium' : 'libreoffice')
        && Number.isSafeInteger(result.images) && result.images > 0 && result.dimensions?.length === result.images
        && result.dimensions.every(size => Array.isArray(size) && size.length === 2
          && size.every(value => Number.isSafeInteger(value) && value > 0)), `Missing CLI format evidence: ${platform}/${format}`);
    }
  }
}

/** Consume a published Release without executing its source or trusting its targetCommitish. */
export async function stageBrowserNpmRelease(tag, directory, { env = process.env, run = gh,
  verifyTrust = verifyNpmOidc, publish = publishNpmPackages } = {}) {
  const version = versionForTag(tag);
  assert(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === sourceRepository
    && env.GITHUB_EVENT_NAME === 'workflow_dispatch', 'Browser npm staging requires a manual workflow in the source repository');
  const result = run(['api', `repos/${sourceRepository}/releases/tags/${tag}`]);
  assert(result.status === 0, 'Cannot read browser Release metadata');
  const release = JSON.parse(result.stdout);
  assert(release.tag_name === tag && release.draft === false && release.prerelease === true,
    'Browser npm staging requires the published prerelease');
  const files = ['browser-preview.json', 'preview-runtime.json', ...['wasm', 'kit'].map(kind =>
    tarballName({ name: kind === 'kit' ? '@deepseek-ai/libreoffice-kit' : '@deepseek-ai/libreoffice-kit-wasm', version }))];
  mkdirSync(directory, { recursive: true });
  assert(readdirSync(directory).length === 0, 'Browser npm staging destination must be empty');
  for (const name of files) {
    const assets = release.assets?.filter(asset => asset.name === name) ?? [];
    assert(assets.length === 1 && assets[0].state === 'uploaded' && Number.isSafeInteger(assets[0].size)
      && assets[0].size > 0 && assets[0].size <= 512 * 1024 * 1024
      && /^sha256:[a-f0-9]{64}$/.test(assets[0].digest), `Missing or invalid browser Release asset: ${name}`);
  }
  const downloaded = run(['release', 'download', tag, '--repo', sourceRepository, '--dir', directory,
    ...files.flatMap(name => ['--pattern', name])]);
  assert(downloaded.status === 0, 'Browser Release download failed');
  for (const name of files) {
    const asset = release.assets.find(asset => asset.name === name);
    assert(statSync(join(directory, name)).size === asset.size
      && `sha256:${sha256(join(directory, name))}` === asset.digest, `Downloaded browser Release asset differs: ${name}`);
  }
  const publication = validateBrowserNpmCandidate(directory, tag);
  assert(env.CLI_RECEIPTS_DIR, 'Staging requires the completed installed CLI matrix');
  validateCliReceipts(env.CLI_RECEIPTS_DIR, readJson(join(directory, 'browser-preview.json')));
  const source = { repository: sourceRepository, commit: publication.sourceCommit };
  verifyReleaseSourceTag(sourceRepository, tag, source, run);
  await verifyTrust({ env, packages: publication.packages.map(record => record.name) });
  // Recheck the actual immutable source tag immediately before the staging writes.
  verifyReleaseSourceTag(sourceRepository, tag, source, run);
  return { sourceCommit: publication.sourceCommit, ...await publish(publication, { tag: 'next' }) };
}

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { 'validate-only': { type: 'boolean' } }, allowPositionals: true });
  assert(positionals.length === 2, 'Usage: stage-browser-npm.mjs <browser-release-tag> <directory> [--validate-only]');
  const [tag, directory] = positionals;
  const result = values['validate-only'] ? validateBrowserNpmCandidate(resolve(directory), tag)
    : await stageBrowserNpmRelease(tag, resolve(directory));
  console.log(JSON.stringify(values['validate-only'] ? { validated: result.packages.length, sourceCommit: result.sourceCommit, version: result.version } : result));
}
