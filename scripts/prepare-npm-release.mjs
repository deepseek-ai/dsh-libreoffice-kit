/** Produce public npm tarballs only from an audited, conversion-qualified candidate. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { validatePublication } from './release-publish.mjs';
import { materializeEngineArchive } from './engine-archive.mjs';
import { auditNpmArchive } from './publication-privacy.mjs';
import { isMain, kitManifest, tarballName } from './platform-matrix.mjs';
import { sha256 } from './verify-artifacts.mjs';

export function prepareNpmRelease(directory, destination, env = process.env) {
  const release = validatePublication(directory, env, { target: 'npm' });
  // Never mix new tarballs with stale or already reviewed publication output.
  mkdirSync(destination);
  const work = mkdtempSync(join(tmpdir(), 'kit-npm-release-'));
  try {
    const packages = [];
    for (const record of release.packages) {
      const tar = materializeEngineArchive(directory, record, work, { requireAnonymousEnvelope: false });
      const file = tarballName(record);
      writeFileSync(join(destination, file), gzipSync(readFileSync(tar), { level: 9 }), { flag: 'wx' });
      packages.push({ name: record.name, version: record.version, file });
    }
    const browser = release.browser;
    copyFileSync(join(directory, browser.file), join(destination, browser.file));
    packages.push({ name: browser.name, version: browser.version, file: browser.file });
    const adapter = kitManifest();
    const adapterFile = tarballName(adapter);
    copyFileSync(join(directory, adapterFile), join(destination, adapterFile));
    packages.push({ name: adapter.name, version: adapter.version, file: adapterFile });
    for (const record of packages) {
      const file = join(destination, record.file);
      const checked = auditNpmArchive(file);
      if (checked.manifest.name !== record.name || checked.manifest.version !== record.version) throw new Error('npm package identity mismatch');
      Object.assign(record, { sha256: sha256(file), bytes: statSync(file).size, access: 'public' });
    }
    const result = { schemaVersion: 1, sourceCommit: env.GITHUB_SHA, releaseManifestSha256: sha256(join(directory, 'release.json')), packages };
    writeFileSync(join(destination, 'npm-publication.json'), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(join(destination, 'publish-order.txt'), `${packages.map(record => record.file).join('\n')}\n`);
    return result;
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: node scripts/prepare-npm-release.mjs <verified-candidate> <new-output-directory>');
  console.log(JSON.stringify(prepareNpmRelease(resolve(process.argv[2]), resolve(process.argv[3])), null, 2));
}
