/** Audit all first-party publication assets, independently of conversion receipts. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { auditBytes, auditNpmArchive, privacyOptions } from './publication-privacy.mjs';
import { materializeEngineArchive } from './engine-archive.mjs';
import { isMain, kitManifest, readJson, tarballName } from './platform-matrix.mjs';

export function auditReleaseCandidate(directory, release, options = privacyOptions(), { target = 'github' } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'kit-publication-audit-'));
  try {
    const failures = [];
    const inspect = (label, callback) => {
      try { return callback(); }
      catch (error) { failures.push(`${label}: ${error.message}`); }
    };
    const packages = release.packages.map(record => inspect(record.name, () => {
      const tar = materializeEngineArchive(directory, record, work, { requireAnonymousEnvelope: target !== 'npm' });
      const checked = auditNpmArchive(tar, options);
      if (checked.manifest.name !== record.name || checked.manifest.version !== record.version) throw new Error('Audited engine identity differs from release');
      return { name: record.name, files: checked.files };
    }));
    packages.push(inspect(kitManifest().name, () => {
      const adapter = auditNpmArchive(join(directory, tarballName(kitManifest())), options);
      if (adapter.manifest.name !== kitManifest().name || adapter.manifest.version !== kitManifest().version) throw new Error('Audited adapter identity differs from release');
      return { name: adapter.manifest.name, files: adapter.files };
    }));
    // These receipts are GitHub assets, not npm package contents. Their integrity
    // and qualification fields are still checked by validatePublication for npm.
    for (const file of target === 'npm' ? [] : ['release.json', 'verification.json'])
      inspect(file, () => auditBytes(readFileSync(join(directory, file)), file, options));
    if (failures.length) throw new Error(`Publication audit failed:\n${failures.map(message => `- ${message}`).join('\n')}`);
    return { packages, passed: true };
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (isMain(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? '.release/npm');
  console.log(JSON.stringify(auditReleaseCandidate(directory, readJson(join(directory, 'release.json'))), null, 2));
}
