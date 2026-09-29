/** Publish only an explicitly verified, complete engine family as GitHub Release assets. */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert, sha256 } from './verify-artifacts.mjs';
import { auditReleaseCandidate } from './release-privacy.mjs';
import { verifyReleaseSourceTag } from './release-source-tag.mjs';
import { engineVersion, enginePrefix, isMain, kitManifest, readJson, releaseRepository, releaseTag, releaseTargets, root, sourceRepository, tarballName } from './platform-matrix.mjs';
import { verifyEngineArchiveRecord } from './engine-archive.mjs';
import { assertRenderingEvidence } from './rendering-evidence.mjs';

/**
 * Check the candidate against its verification receipts before any upload.
 * @param directory - Release candidate directory.
 * @param env - Workflow environment naming the release tag and source commit.
 * @param options - Destination determines whether the transfer envelope itself is published.
 * @returns the verified release manifest.
 */
export function validatePublication(directory, env = process.env, { target = 'github' } = {}) {
  assert(['github', 'npm'].includes(target), 'Unsupported publication target');
  const release = readJson(join(directory, 'release.json'));
  assert(release.schemaVersion === 1, 'Unsupported release manifest');
  assert(release.version === readJson(join(root, 'package.json')).version, 'Release version differs from the engine workspace');
  assert(env.GITHUB_REF === `refs/tags/${releaseTag(release.version)}`,
    `Publication requires the matching release tag ${releaseTag(release.version)}; found ${env.GITHUB_REF ?? '(unset)'}`);
  assert(JSON.stringify([...release.platforms].sort()) === JSON.stringify(releaseTargets([]).sort()), 'Publication requires every declared release platform; a partial or development-target pack cannot be published');
  const expected = release.platforms.map((platform) => `${enginePrefix}-${platform}`);
  assert(JSON.stringify(release.packages.map((record) => record.name)) === JSON.stringify(expected), 'Release package order is incomplete or names an undeclared package');
  for (const [index, record] of release.packages.entries()) {
    assert(record.platform === release.platforms[index], 'Release platform differs from the canonical engine asset');
    verifyEngineArchiveRecord(record);
    assert(record.version === engineVersion(record.platform) && statSync(join(directory, record.file)).size === record.bytes && sha256(join(directory, record.file)) === record.sha256, `Invalid release tarball: ${record.file}`);
  }
  const evidence = readJson(join(directory, 'verification.json'));
  assert(evidence.sourceCommit === env.GITHUB_SHA && /^[a-f0-9]{40}$/.test(evidence.sourceCommit), 'Verification is not for this release commit');
  assert(evidence.releaseManifestSha256 === sha256(join(directory, 'release.json')), 'Verification belongs to different release bytes');
  const adapterSha256 = sha256(join(directory, tarballName(kitManifest())));
  for (const platform of release.platforms) {
    const record = evidence.platforms.find((entry) => entry.platform === platform);
    assert(record?.nativeInstalled === (platform !== 'wasm') && record?.wasmInstalled === (platform === 'wasm') && record?.passed === true,
      `Missing native/WASM installed conversion evidence: ${platform}`);
    const conversion = record[platform === 'wasm' ? 'wasm' : 'native'];
    assert(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].every(format => conversion?.formats?.[format]?.backend === (platform === 'wasm' ? 'wasm' : 'native')
      && conversion.formats[format].pdfBytes > 100), `Missing Office format conversion evidence: ${platform}`);
    assertRenderingEvidence(conversion?.rendering, platform === 'wasm' ? 'wasm' : 'native');
    assert(conversion?.adapter?.sha256 === adapterSha256,
      `Verification belongs to different adapter bytes: ${platform}`);
    assert(conversion?.embeddedGraphics?.pdfInEmf === true,
      `Missing embedded PDF graphic conversion evidence: ${platform}`);
  }
  auditReleaseCandidate(directory, release, undefined, { target });
  return release;
}

/**
 * Asset names one verified candidate publishes. Engine tarballs come first so a
 * reader lists the engines before the receipts that describe them.
 * @param release - Verified release manifest.
 * @returns every asset name in upload order.
 */
export function publicationAssets(release) {
  return [...release.packages.map((record) => record.file), tarballName(kitManifest()), 'artifact-manifest.json', 'SHA256SUMS', 'release.json', 'verification.json'];
}

/**
 * Write the checksum list and artifact manifest that reviewers and installers
 * verify a download against.
 * @param directory - Release candidate directory.
 * @param release - Verified release manifest.
 * @param repository - GitHub repository owning the release.
 * @returns the written artifact manifest.
 */
export function writePublicationIndex(directory, release, repository) {
  const packages = release.packages.map((record) => {
    const file = join(directory, record.file);
    assert(sha256(file) === record.sha256, `Invalid release tarball: ${record.file}`);
    return { name: record.name, version: record.version, platform: record.platform, file: record.file, sha256: record.sha256, bytes: statSync(file).size, install: record.install };
  });
  const source = { repository: sourceRepository, commit: readJson(join(directory, 'verification.json')).sourceCommit,
    releaseManifestSha256: sha256(join(directory, 'release.json')), verificationSha256: sha256(join(directory, 'verification.json')) };
  const adapterManifest = kitManifest();
  const adapterFile = tarballName(adapterManifest);
  const adapter = { name: adapterManifest.name, version: adapterManifest.version, file: adapterFile, sha256: sha256(join(directory, adapterFile)), bytes: statSync(join(directory, adapterFile)).size };
  const manifest = { adapter, repository, tag: releaseTag(release.version), version: release.version, source, packages };
  writeFileSync(join(directory, 'artifact-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, 'SHA256SUMS'), `${[...packages, adapter].map((record) => `${record.sha256}  ${record.file}`).join('\n')}\n`);
  return manifest;
}

/**
 * Write release notes listing the assets a reader verifies.
 * @param work - Scratch directory that receives the notes file.
 * @param manifest - Artifact manifest the notes describe.
 * @returns the notes file path.
 */
export function writeReleaseNotes(work, manifest) {
  const rows = [...manifest.packages, { ...manifest.adapter, platform: 'Node API' }].map((record) =>
    `| \`${record.platform}\` | \`${record.name}\` | ${record.bytes} | \`${record.sha256}\` |`);
  const file = join(work, 'release-notes.md');
  writeFileSync(file, [
    'Standalone Office-to-PDF conversion for Node.js: DOC, DOCX, XLS, XLSX, PPT and PPTX. Required native engines serve macOS and Windows on ARM64 and x64; Linux uses WASM. macOS and Windows do not fall back to WASM.',
    '',
    `Source: [${manifest.source.repository}@${manifest.source.commit}](https://github.com/${manifest.source.repository}/tree/${manifest.source.commit}). GitHub downloads require repository access. npm distribution uses standard .tgz packages; conversion runs without network access.`,
    '',
    '| Platform | Package | Bytes | SHA-256 |',
    '| --- | --- | ---: | --- |',
    ...rows,
    '',
    '`artifact-manifest.json` records every published asset and `SHA256SUMS` verifies a download. The Node API and all declared prebuilt engines belong to this verified candidate. Engine archives retain their matching source recipes and license notices.',
    '',
  ].join('\n'));
  return file;
}

function gh(args, capture) {
  const result = spawnSync('gh', args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  if (result.error) throw result.error;
  return result;
}

/** Existing assets keyed by name, or undefined when the tag carries no release yet. */
function publishedAssets(repository, tag, run) {
  const result = run(['api', `repos/${repository}/releases/tags/${tag}`], true);
  if (result.status !== 0) {
    if (/\bHTTP 404\b/.test(result.stderr ?? '')) return undefined;
    throw new Error(`Cannot inspect the existing GitHub Release: ${result.stderr ?? 'unknown GitHub CLI failure'}`);
  }
  const { assets, draft } = JSON.parse(result.stdout);
  return { assets: new Map(assets.map((asset) => [asset.name, asset])), draft };
}

/**
 * Create or complete the reviewed release. Assets already carrying the same
 * bytes stay untouched; a same-named asset with different bytes fails before
 * any upload.
 * @param directory - Release candidate directory holding verified tarballs.
 * @param options - Repository, notes file, workflow environment, and GitHub CLI runner.
 * @returns the release tag and the published asset names.
 */
export function publishRelease(directory, { repository = releaseRepository, notesFile, env = process.env, run = gh } = {}) {
  assert(repository === releaseRepository, `Invalid GitHub repository: expected ${releaseRepository}`);
  const release = validatePublication(directory, env);
  const tag = releaseTag(release.version);
  const manifest = writePublicationIndex(directory, release, repository);
  const assets = publicationAssets(release);
  const access = run(['api', `repos/${repository}`], true);
  assert(access.status === 0, `Cannot inspect release repository access: ${access.stderr ?? 'GitHub CLI error'}`);
  const destination = JSON.parse(access.stdout);
  assert(destination.full_name === repository && destination.visibility === 'internal' && destination.permissions?.push === true,
    'Publication requires write access to the internal engine repository');
  const published = publishedAssets(repository, tag, run);
  for (const file of assets) {
    const found = published?.assets.get(file);
    if (found === undefined) continue;
    const local = join(directory, file);
    assert(found.size === statSync(local).size, `The ${tag} release already carries different ${file} bytes`);
    assert(typeof found.digest === 'string', `GitHub has no checksum for existing release asset ${file}`);
    assert(found.digest === `sha256:${sha256(local)}`, `The ${tag} release already carries different ${file} bytes`);
  }
  if (published === undefined) assert(typeof notesFile === 'string' && notesFile.length > 0, 'Creating the release requires release notes');
  verifyReleaseSourceTag(repository, tag, manifest.source, run);
  const missing = assets.filter((file) => published?.assets.get(file) === undefined);
  if (missing.length !== 0) {
    const paths = missing.map((file) => join(directory, file));
    const result = published === undefined
      ? run(['release', 'create', tag, '--repo', repository, '--verify-tag', '--title', `LibreOffice Kit ${release.version}`, '--notes-file', notesFile, '--draft', ...paths])
      : run(['release', 'upload', tag, '--repo', repository, ...paths]);
    assert(result.status === 0, `Publication failed for ${tag}; the remaining assets were not uploaded`);
  }
  if (published === undefined || published.draft) {
    const result = run(['release', 'edit', tag, '--repo', repository, '--draft=false', '--latest=false']);
    assert(result.status === 0, `Could not publish the uploaded ${tag} draft`);
  }
  return { tag, assets, manifest };
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  const directory = resolve(args[0] && !args[0].startsWith('--') ? args.shift() : join(root, '.release/npm'));
  assert(args.length === 1 && ['--publish', '--validate-only'].includes(args[0]), 'Pass --publish or --validate-only for the verified release');
  const work = mkdtempSync(join(tmpdir(), 'libreoffice-kit-release-'));
  try {
    const repository = releaseRepository;
    const manifest = writePublicationIndex(directory, validatePublication(directory), repository);
    console.log(JSON.stringify(args[0] === '--validate-only' ? manifest
      : publishRelease(directory, { repository, notesFile: writeReleaseNotes(work, manifest) }), null, 2));
  } finally { rmSync(work, { recursive: true, force: true }); }
}
