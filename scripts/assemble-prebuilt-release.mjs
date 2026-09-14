/** Assemble existing engine bytes for fresh qualification with the current Node API. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { materializeEngineArchive, packEngineArchive } from './engine-archive.mjs';
import { auditBytes, auditNpmArchive, visitTar } from './publication-privacy.mjs';
import { packDependencies } from './pack-dependencies.mjs';
import { npm } from './pack-utils.mjs';
import { stagePackage, workflowRepositoryUrl } from './pack-release.mjs';
import { verifyPreparedEngine } from './prepare-artifacts.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';
import { isMain, kitDirectory, kitManifest, readJson, releaseTargets, root, tarballName } from './platform-matrix.mjs';

/** Newly promoted targets must carry build recipes already saved in this checkout. */
export function verifyPromotedRecipe(tar, repo = root) {
  const files = [];
  const packed = readFileSync(tar);
  visitTar(packed[0] === 0x1f && packed[1] === 0x8b ? gunzipSync(packed) : packed, ({ name, data, type }) => {
    if (type !== '0' || !/^package\/sources\/(engine|scripts)\//.test(name)) return;
    const file = name.slice('package/sources/'.length);
    assert(!file.split('/').includes('..'), 'Unsafe source recipe path');
    const current = existsSync(join(repo, file)) ? readFileSync(join(repo, file)) : undefined;
    // Git normalizes our JS files on Windows; upstream patch bytes always remain exact.
    const normalizeJs = bytes => {
      const text = bytes.toString('utf8');
      assert(Buffer.from(text).equals(bytes), 'Invalid UTF-8 source recipe');
      return text.replaceAll('\r\n', '\n');
    };
    assert(current && (current.equals(data) || (file.endsWith('.mjs') && normalizeJs(current) === normalizeJs(data))),
      `Promoted engine source differs from checkout: ${file}`);
    files.push(file);
  });
  assert(files.includes('engine/native/worker.cxx') && files.includes('engine/native/build-helper.mjs')
    && files.some(file => file.startsWith('engine/native/patches/')), 'Promoted engine lacks its native source recipe');
  return files;
}

/** Supplemental receipts supply engine identities, never release-wide runtime evidence. */
export function supplementalEngine(receipt, platform, version) {
  assert(receipt.version === version && receipt.platform === platform && receipt.engines?.length === 1,
    'Invalid supplemental engine record');
  const record = receipt.engines[0];
  assert(record.platform === platform && record.name === `@deepseek-ai/libreoffice-kit-${platform}` && record.version === version,
    'Supplemental engine identity mismatch');
  return record;
}

export function assemblePrebuiltRelease(input, destination, preparedPlatforms = []) {
  const previous = readJson(join(input, 'release.json'));
  const remote = readJson(join(input, 'github-assets.json'));
  const platforms = releaseTargets([]);
  const version = kitManifest().version;
  assert(previous.version === version, 'Existing release has a different version');
  assert(new Set(preparedPlatforms).size === preparedPlatforms.length
    && preparedPlatforms.every(platform => platform !== 'wasm' && platforms.includes(platform)), 'Invalid prepared native platforms');
  const verifyDownload = file => {
    assert(/^[A-Za-z0-9._-]+$/.test(file), 'Unsafe release asset filename');
    const bytes = readFileSync(join(input, file));
    const asset = remote.assets.find(asset => asset.name === file);
    assert(asset && asset.size === bytes.length && asset.digest === `sha256:${sha256(join(input, file))}`, `Downloaded asset differs from GitHub: ${file}`);
  };
  verifyDownload('release.json');
  auditBytes(readFileSync(join(input, 'release.json')), 'release.json');
  const records = [...previous.packages];
  for (const [platform, file] of [['win32-x64', 'windows-verification.json'], ['win32-arm64', 'windows-arm64-verification.json']]) {
    if (!platforms.includes(platform) || preparedPlatforms.includes(platform) || records.some(record => record.platform === platform)) continue;
    verifyDownload(file);
    auditBytes(readFileSync(join(input, file)), file);
    records.push(supplementalEngine(readJson(join(input, file)), platform, version));
  }
  mkdirSync(destination);
  const work = mkdtempSync(join(tmpdir(), 'kit-prebuilt-candidate-'));
  try {
    const packages = platforms.map(platform => {
      if (preparedPlatforms.includes(platform)) {
        const directory = join(root, 'packages', platform);
        verifyPreparedEngine(platform, directory);
        const manifest = readJson(join(directory, 'package.json'));
        const staged = join(work, platform);
        stagePackage(directory, staged, manifest, workflowRepositoryUrl());
        npm(['pack', '--json', '--ignore-scripts', '--pack-destination', work], staged, work);
        const gzip = join(work, tarballName(manifest));
        verifyPromotedRecipe(gzip);
        const record = { name: manifest.name, version, platform, ...packEngineArchive(gzip, destination, manifest) };
        rmSync(gzip);
        return record;
      }
      const matches = records.filter(record => record.platform === platform);
      assert(matches.length === 1, `Missing or duplicate engine: ${platform}`);
      const record = matches[0];
      assert(record.name === `@deepseek-ai/libreoffice-kit-${platform}` && record.version === version, 'Engine identity differs from the release declaration');
      verifyDownload(record.file);
      const tar = materializeEngineArchive(input, record, work);
      const checked = auditNpmArchive(tar);
      assert(checked.manifest.name === record.name && checked.manifest.version === version, 'Inner package identity differs from its record');
      if (!previous.platforms.includes(platform)) verifyPromotedRecipe(tar);
      copyFileSync(join(input, record.file), join(destination, record.file));
      rmSync(tar);
      return record;
    });
    const dependencies = packDependencies(kitDirectory(), join(destination, 'dependencies'), work);
    const result = { schemaVersion: 1, version, platforms, packages, dependencies };
    writeFileSync(join(destination, 'release.json'), `${JSON.stringify(result, null, 2)}\n`);
    // Old conversion receipts are intentionally not copied: every host must test these candidate bytes.
    return result;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  assert(process.argv.length >= 4, 'Usage: node scripts/assemble-prebuilt-release.mjs <downloads> <new-candidate> [prepared-native-platform ...]');
  console.log(JSON.stringify(assemblePrebuiltRelease(resolve(process.argv[2]), resolve(process.argv[3]), process.argv.slice(4)), null, 2));
}
