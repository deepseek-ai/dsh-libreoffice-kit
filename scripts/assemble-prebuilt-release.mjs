/** Assemble existing engine bytes for fresh qualification with the current Node API. */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { materializeEngineArchive } from './engine-archive.mjs';
import { auditBytes, auditNpmArchive, visitTar } from './publication-privacy.mjs';
import { packDependencies } from './pack-dependencies.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';
import { isMain, kitDirectory, kitManifest, readJson, releaseTargets, root } from './platform-matrix.mjs';

/** Newly promoted targets must carry build recipes already saved in this checkout. */
export function verifyPromotedRecipe(tar, repo = root) {
  const files = [];
  visitTar(readFileSync(tar), ({ name, data, type }) => {
    if (type !== '0' || !/^package\/sources\/(engine|scripts)\//.test(name)) return;
    const file = name.slice('package/sources/'.length);
    assert(!file.split('/').includes('..'), 'Unsafe source recipe path');
    assert(existsSync(join(repo, file)) && readFileSync(join(repo, file)).equals(data), `Promoted engine source differs from checkout: ${file}`);
    files.push(file);
  });
  assert(files.includes('engine/native/worker.cxx') && files.includes('engine/native/build-helper.mjs')
    && files.some(file => file.startsWith('engine/native/patches/')), 'Promoted engine lacks its native source recipe');
  return files;
}

export function assemblePrebuiltRelease(input, destination) {
  const previous = readJson(join(input, 'release.json'));
  const remote = readJson(join(input, 'github-assets.json'));
  const platforms = releaseTargets([]);
  const version = kitManifest().version;
  assert(previous.version === version, 'Existing release has a different version');
  const verifyDownload = file => {
    assert(/^[A-Za-z0-9._-]+$/.test(file), 'Unsafe release asset filename');
    const bytes = readFileSync(join(input, file));
    const asset = remote.assets.find(asset => asset.name === file);
    assert(asset && asset.size === bytes.length && asset.digest === `sha256:${sha256(join(input, file))}`, `Downloaded asset differs from GitHub: ${file}`);
  };
  verifyDownload('release.json');
  auditBytes(readFileSync(join(input, 'release.json')), 'release.json');
  const records = [...previous.packages];
  if (platforms.includes('win32-x64') && !records.some(record => record.platform === 'win32-x64')) {
    verifyDownload('windows-verification.json');
    auditBytes(readFileSync(join(input, 'windows-verification.json')), 'windows-verification.json');
    const windows = readJson(join(input, 'windows-verification.json'));
    assert(windows.version === version && windows.platform === 'win32-x64' && windows.engines?.length === 1,
      'Invalid supplemental Windows engine record');
    records.push(windows.engines[0]);
  }
  mkdirSync(destination);
  const work = mkdtempSync(join(tmpdir(), 'kit-prebuilt-candidate-'));
  try {
    const packages = platforms.map(platform => {
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
  assert(process.argv.length === 4, 'Usage: node scripts/assemble-prebuilt-release.mjs <downloads> <new-candidate>');
  console.log(JSON.stringify(assemblePrebuiltRelease(resolve(process.argv[2]), resolve(process.argv[3])), null, 2));
}
