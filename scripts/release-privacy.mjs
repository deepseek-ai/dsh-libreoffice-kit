/** Audit all first-party publication assets, independently of conversion receipts. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { auditBytes, auditNpmArchive, privacyOptions } from './publication-privacy.mjs';
import { materializeEngineArchive } from './engine-archive.mjs';
import { isMain, kitManifest, readJson, tarballName } from './platform-matrix.mjs';

export function auditReleaseCandidate(directory, release, options = privacyOptions()) {
  const work = mkdtempSync(join(tmpdir(), 'kit-publication-audit-'));
  try {
    const packages = release.packages.map(record => {
      const tar = materializeEngineArchive(directory, record, work);
      const checked = auditNpmArchive(tar, options);
      if (checked.manifest.name !== record.name || checked.manifest.version !== record.version) throw new Error('Audited engine identity differs from release');
      return { name: record.name, files: checked.files };
    });
    const adapter = auditNpmArchive(join(directory, tarballName(kitManifest())), options);
    if (adapter.manifest.name !== kitManifest().name || adapter.manifest.version !== kitManifest().version) throw new Error('Audited adapter identity differs from release');
    for (const file of ['release.json', 'verification.json']) auditBytes(readFileSync(join(directory, file)), file, options);
    return { packages: [...packages, { name: adapter.manifest.name, files: adapter.files }], passed: true };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? '.release/npm');
  console.log(JSON.stringify(auditReleaseCandidate(directory, readJson(join(directory, 'release.json'))), null, 2));
}
