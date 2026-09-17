/** Stage qualified npm archives for a maintainer to review and approve on npm. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { validatePublication } from './release-publish.mjs';
import { auditNpmArchive } from './publication-privacy.mjs';
import { isMain, kitManifest, readJson, sourceRepository, tarballName } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';

export const npmRegistry = 'https://registry.npmjs.org/';
const diagnosticCodes = new Set(['E409', 'E429', 'E500', 'E502', 'E503', 'E504', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN',
  'E400', 'E401', 'E403', 'E404', 'E413', 'E422', 'EOTP', 'ENEEDAUTH',
  'EUSAGE', 'EPUBLISHCONFLICT', 'EPRIVATE', 'EINVALIDPACKAGENAME', 'EVALIDATION', 'ENOENT', 'ENOTFOUND', 'EPIPE']);
const spacingMs = 2_000;

/** Hash streaming bytes so large engine archives do not add a second in-memory tar. */
async function digestFile(file, { gzip = false, maximumBytes = Infinity } = {}) {
  const hashes = { sha256: createHash('sha256'), sha512: createHash('sha512') };
  let bytes = 0;
  const sink = new Writable({ write(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maximumBytes) return callback(new Error('npm archive exceeds the qualified engine tar size'));
    for (const hash of Object.values(hashes)) hash.update(chunk);
    callback();
  } });
  await pipeline(createReadStream(file), ...(gzip ? [createGunzip()] : []), sink);
  return { bytes, sha256: hashes.sha256.digest('hex'), integrity: `sha512-${hashes.sha512.digest('base64')}` };
}

function repositoryUrl(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url;
  return typeof value === 'string' ? value.replace(/^git\+/, '').replace(/\.git\/?$/, '').replace(/\/$/, '') : undefined;
}

/** Validate the prepared npm archives against both their index and the qualified engine bytes. */
export async function validateNpmPublication(candidateDirectory, npmDirectory, env = process.env) {
  const release = validatePublication(candidateDirectory, env, { target: 'npm' });
  const publication = readJson(join(npmDirectory, 'npm-publication.json'));
  assert(publication.schemaVersion === 1, 'Unsupported npm publication manifest');
  assert(publication.sourceCommit === env.GITHUB_SHA, 'npm publication belongs to a different source commit');
  assert(publication.releaseManifestSha256 === sha256(join(candidateDirectory, 'release.json')),
    'npm publication belongs to a different qualified candidate');
  const adapter = kitManifest();
  assert(adapter.version === release.version, 'npm Node API version differs from the qualified engine family');
  const expected = [...release.packages, release.browser, adapter].map(record => ({ name: record.name, version: record.version, file: tarballName(record) }));
  assert(Array.isArray(publication.packages) && publication.packages.length === expected.length, 'npm publication requires every declared package');
  const order = readFileSync(join(npmDirectory, 'publish-order.txt'), 'utf8');
  assert(order === `${expected.map(record => record.file).join('\n')}\n`, 'npm publish order must list each engine before the Node API');
  const packages = [];
  for (const [index, identity] of expected.entries()) {
    const record = publication.packages[index];
    assert(record?.name === identity.name && record?.version === identity.version && record?.file === identity.file,
      'npm publication package identity or canonical order mismatch');
    assert(record.access === 'public', 'npm publication requires public package access');
    const file = join(npmDirectory, identity.file);
    const stat = lstatSync(file);
    assert(stat.isFile() && stat.size === record.bytes && Number.isSafeInteger(record.bytes) && record.bytes > 0,
      `Invalid npm archive size or file type: ${identity.name}`);
    const digest = await digestFile(file);
    assert(digest.sha256 === record.sha256, `npm archive checksum mismatch: ${identity.name}`);
    const engine = release.packages[index];
    if (engine) {
      const inner = await digestFile(file, { gzip: true, maximumBytes: engine.install.bytes });
      assert(inner.bytes === engine.install.bytes && inner.sha256 === engine.install.sha256,
        `npm engine differs from its qualified installation tar: ${identity.name}`);
    } else {
      assert(digest.sha256 === sha256(join(candidateDirectory, identity.file)), 'npm Browser/Node API differs from its qualified archive');
    }
    const { manifest } = auditNpmArchive(file);
    assert(manifest.name === identity.name && manifest.version === identity.version, 'npm archive manifest identity mismatch');
    assert((manifest.private === undefined || manifest.private === false) && manifest.publishConfig?.access === 'public', 'npm archive manifest must permit public publication');
    assert(manifest.publishConfig?.registry === undefined || manifest.publishConfig.registry === npmRegistry
      || manifest.publishConfig.registry === npmRegistry.slice(0, -1), 'npm archive names an unexpected publication registry');
    assert(repositoryUrl(manifest.repository) === `https://github.com/${sourceRepository}`, 'npm archive repository must match the source repository');
    packages.push({ ...identity, path: file, integrity: digest.integrity,
      ...(engine ? { engineInstall: { bytes: engine.install.bytes, sha256: engine.install.sha256 } } : {}) });
  }
  return { version: release.version, packages };
}

function npm(args) {
  return spawnSync('npm', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15 * 60 * 1000 });
}

/** Extract an npm error code, never echo registry output or credential-bearing diagnostics. */
function errorCode(result) {
  try {
    const code = JSON.parse(result.stdout ?? '').error?.code;
    if (diagnosticCodes.has(code)) return code;
  } catch { /* npm versions may report errors only on stderr. */ }
  const match = (result.stderr ?? '').match(/^\s*npm (?:ERR!|error) code (E[A-Z0-9_]+)\s*$/m);
  return diagnosticCodes.has(match?.[1]) ? match[1] : (diagnosticCodes.has(result.error?.code) ? result.error.code : 'UNKNOWN');
}

/** An absent version is established only by the registry's explicit 404 response. */
export function npmVersionState(record, run = npm) {
  const result = run(['view', `${record.name}@${record.version}`, 'dist.integrity', '--json', '--registry', npmRegistry]);
  if (result.status !== 0) {
    const code = errorCode(result);
    if (code === 'E404') return { kind: 'absent' };
    throw new Error(`Cannot inspect npm version ${record.name}@${record.version} (${code}); registry details redacted`);
  }
  let integrity;
  try { integrity = JSON.parse(result.stdout); } catch { /* Report the invalid response without its contents. */ }
  assert(typeof integrity === 'string' && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity), `npm registry returned invalid integrity for ${record.name}@${record.version}`);
  return { kind: 'present', integrity };
}

function assertRegistryUrl(value) {
  let url;
  try { url = new URL(value); } catch { /* Do not expose untrusted URL contents. */ }
  assert(url?.origin === npmRegistry.slice(0, -1) && !url.username && !url.password,
    'npm registry returned an unexpected engine archive URL');
  return url.href;
}

/** Fetch a public npm tarball into a private temporary file, with no redirects or credentials. */
export async function downloadRegistryArchive(url, file, maximumBytes, request = fetch) {
  assertRegistryUrl(url);
  try {
    const response = await request(url, { redirect: 'error', signal: AbortSignal.timeout(15 * 60 * 1000) });
    assert(response.ok && response.body, 'npm engine archive download failed');
    const length = response.headers.get('content-length');
    assert(length === null || (/^[0-9]+$/.test(length) && Number(length) <= maximumBytes), 'npm engine archive download exceeds its size limit');
    let bytes = 0;
    const limit = new Transform({ transform(chunk, encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maximumBytes ? new Error('npm engine archive download exceeds its size limit') : null, chunk);
    } });
    await pipeline(Readable.fromWeb(response.body), limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch {
    throw new Error('Cannot download the existing npm engine archive within its size limit; network details redacted');
  }
}

/**
 * gzip output varies across zlib versions. An existing engine with a different
 * gzip digest may be skipped only after checking the registry digest, auditing
 * the downloaded archive, and proving its exact tar is the qualified tar.
 * The Node API has no such exception: its original archive must match exactly.
 */
async function assertMatching(record, state, { run, download }) {
  if (state.kind === 'absent' || state.integrity === record.integrity) return;
  assert(record.engineInstall && Number.isSafeInteger(record.engineInstall.bytes) && record.engineInstall.bytes > 0
    && /^[a-f0-9]{64}$/.test(record.engineInstall.sha256),
  `npm version ${record.name}@${record.version} already exists with different bytes; publication stopped`);
  const result = run(['view', `${record.name}@${record.version}`, 'dist.tarball', '--json', '--registry', npmRegistry]);
  assert(result.status === 0, `Cannot inspect the existing npm engine archive (${errorCode(result)}); registry details redacted`);
  let value;
  try { value = JSON.parse(result.stdout); } catch { /* Report malformed JSON without its contents. */ }
  const url = assertRegistryUrl(value);
  const maximumBytes = Math.min(1024 ** 3, record.engineInstall.bytes + 1024 ** 2);
  const directory = mkdtempSync(join(tmpdir(), 'kit-existing-npm-'));
  try {
    const file = join(directory, 'engine.tgz');
    await download(url, file, maximumBytes);
    assert(lstatSync(file).isFile(), 'Existing npm engine archive must be a regular file');
    const archive = await digestFile(file, { maximumBytes });
    assert(archive.integrity === state.integrity, `Existing npm engine archive disagrees with registry integrity: ${record.name}`);
    const inner = await digestFile(file, { gzip: true, maximumBytes: record.engineInstall.bytes });
    assert(inner.bytes === record.engineInstall.bytes && inner.sha256 === record.engineInstall.sha256,
      `npm engine ${record.name}@${record.version} already exists with different qualified installation bytes; publication stopped`);
    const { manifest } = auditNpmArchive(file);
    assert(manifest.name === record.name && manifest.version === record.version, 'Existing npm engine archive identity mismatch');
    state.equivalentEngineTar = true;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Dist-tags are explicit, and a prerelease cannot replace the stable tag. */
export function validateDistTag(version, tag) {
  assert(['latest', 'next'].includes(tag), 'npm publication requires --tag latest or --tag next');
  assert(tag !== 'latest' || !version.includes('-'), 'A prerelease cannot publish under the latest dist-tag');
}

/**
 * Stage a fully validated family. Staging does not publish a version or change
 * registry dist-tags; a maintainer must review and approve each returned stage.
 * A public-registry lookup cannot tell whether an earlier staging POST landed,
 * so each package is attempted once and uncertain failures require inspection.
 */
export async function publishNpmPackages(publication, { tag, run = npm, download = downloadRegistryArchive, sleep = delay, log = console.log } = {}) {
  validateDistTag(publication.version, tag);
  // Preflight the complete family before the first staging POST, so a conflict
  // late in the sequence does not leave unnecessary pending stages behind.
  const states = [];
  for (const record of publication.packages) {
    const state = npmVersionState(record, run);
    await assertMatching(record, state, { run, download });
    states.push(state);
  }
  const stages = [];
  let skippedPublished = 0;
  for (const [index, record] of publication.packages.entries()) {
    if (states[index].kind === 'present') {
      log(`npm stage: ${record.name}@${record.version} is already published with ${states[index].equivalentEngineTar ? 'the identical qualified engine tar (gzip differs)' : 'identical bytes'}; skipped`);
      skippedPublished++;
      continue;
    }
    if (stages.length > 0) await sleep(spacingMs);
    const result = run(['stage', 'publish', record.path, '--ignore-scripts', '--access', 'public', '--tag', tag,
      '--registry', npmRegistry, '--provenance=false', '--json']);
    assert(result.status === 0,
      `npm stage publish did not confirm success for ${record.name}@${record.version} (${errorCode(result)}); `
      + 'inspect npm staged packages before retrying because the upload may have landed; registry details redacted');
    let receipt;
    try { receipt = JSON.parse(result.stdout)?.[record.name]; } catch { /* Never echo npm output containing untrusted metadata. */ }
    assert(receipt?.name === record.name && receipt?.version === record.version
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(receipt?.stageId ?? ''),
    `npm stage publish reported success for ${record.name}@${record.version} without a valid stage receipt; inspect npm staged packages before retrying`);
    const stage = { name: record.name, version: record.version, stageId: receipt.stageId };
    stages.push(stage);
    log(`npm stage: ${record.name}@${record.version} staged as ${stage.stageId}; awaiting maintainer review and approval on npm`);
  }
  return { staged: stages.length, skippedPublished, stages };
}

export async function publishNpmRelease(candidateDirectory, npmDirectory, options = {}) {
  const publication = await validateNpmPublication(candidateDirectory, npmDirectory, options.env ?? process.env);
  validateDistTag(publication.version, options.tag);
  if (options.validateOnly) return { validated: publication.packages.length, version: publication.version, tag: options.tag };
  return publishNpmPackages(publication, options);
}

if (isMain(import.meta.url)) {
  const { values, positionals } = parseArgs({ options: { tag: { type: 'string' }, 'validate-only': { type: 'boolean' } }, allowPositionals: true });
  assert(positionals.length === 2, 'Usage: node scripts/publish-npm-release.mjs <candidate-directory> <npm-directory> --tag latest|next [--validate-only]');
  const result = await publishNpmRelease(resolve(positionals[0]), resolve(positionals[1]), { tag: values.tag, validateOnly: values['validate-only'] });
  console.log(JSON.stringify(result));
}
