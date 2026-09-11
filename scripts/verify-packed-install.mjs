/** Rehearse consumer installation without registry access or source-checkout resolution. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { npm, run } from './pack-utils.mjs';
import { assert, sha256, verifyEnginePackage } from './verify-artifacts.mjs';
import { verifyEntryPackage } from './verify-entry.mjs';
import { entryName, hostTarget, isMain, readJson, root } from './platform-matrix.mjs';

/** expectedBackend asserts actual selection; only wasmOnly controls whether native is installed. */
export function verifyPackedInstall(directory, { wasmOnly = false, expectedBackend = wasmOnly ? 'wasm' : 'native', keep } = {}) {
  if (keep) assert(!existsSync(keep), `Retained installation destination already exists: ${keep}`);
  const release = readJson(join(directory, 'release.json'));
  assert(release.schemaVersion === 1, 'Unsupported release manifest');
  const platform = hostTarget();
  if (!wasmOnly) assert(platform && release.platforms.includes(platform), `Release lacks host package ${platform}`);
  const selected = release.packages.filter((record) => ['entry', 'wasm', ...(wasmOnly ? [] : [platform])].includes(record.platform));
  assert(selected.length === (wasmOnly ? 2 : 3), 'Release manifest omits an installed engine or entry');
  for (const record of [...release.packages, ...release.dependencies]) {
    assert(sha256(join(directory, record.file)) === record.sha256, `Tarball checksum mismatch: ${record.file}`);
  }
  const work = mkdtempSync(join(tmpdir(), 'libreoffice-kit-install-'));
  try {
    const consumer = join(work, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ name: 'libreoffice-kit-install-smoke', version: '0.0.0', private: true, type: 'module',
      dependencies: Object.fromEntries([...selected, ...release.dependencies].map((record) => [record.name, `file:${join(directory, record.file)}`])),
    }, null, 2)}\n`);
    npm(['install', '--offline', '--ignore-scripts', '--package-lock=false', '--omit=optional'], consumer, work);
    for (const record of selected) {
      const installed = join(consumer, 'node_modules', ...record.name.split('/'));
      if (record.platform === 'entry') verifyEntryPackage(installed, true);
      else verifyEnginePackage(installed);
    }
    cpSync(join(root, 'scripts/smoke-installed.mjs'), join(consumer, 'smoke.mjs'));
    cpSync(join(root, 'test/runtime-linked-fixture.mjs'), join(consumer, 'runtime-linked-fixture.mjs'));
    cpSync(join(root, 'test/fixtures'), join(consumer, 'fixtures'), { recursive: true });
    run(process.execPath, ['smoke.mjs', expectedBackend], { cwd: consumer,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, timeout: 180_000 });
    const result = readJson(join(consumer, 'smoke-result.json'));
    assert(result.backend === expectedBackend && result.pdfBytes > 100, 'Installed conversion did not return the expected PDF/backend');
    assert(['docx', 'xlsx', 'pptx'].every(format => result.formats?.[format]?.backend === result.backend && result.formats[format].pdfBytes > 100),
      'Installed conversion must include DOCX, XLSX, and PPTX PDFs');
    if (keep) {
      mkdirSync(dirname(keep), { recursive: true });
      for (const file of ['smoke.mjs', 'runtime-linked-fixture.mjs', 'smoke-result.json', 'roundtrip.docx', 'roundtrip.pdf', 'roundtrip.xlsx.pdf', 'roundtrip.pptx.pdf', 'external.docx', 'external.pdf'])
        rmSync(join(consumer, file));
      rmSync(join(consumer, 'fixtures'), { recursive: true });
      try { renameSync(consumer, keep); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        try { cpSync(consumer, keep, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }); }
        catch (error) { rmSync(keep, { recursive: true, force: true }); throw error; }
      }
    }
    return { ...result, installedOutsideRepository: true, network: 'offline', ...(keep ? { retainedInstallation: keep } : {}) };
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
}

if (isMain(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(root, '.release/npm'));
  const keepIndex = process.argv.indexOf('--keep');
  if (keepIndex !== -1) assert(process.argv[keepIndex + 1] && !process.argv[keepIndex + 1].startsWith('--'), '--keep requires a destination path');
  console.log(JSON.stringify(verifyPackedInstall(directory, { wasmOnly: process.argv.includes('--wasm-only'), ...(keepIndex === -1 ? {} : { keep: resolve(process.argv[keepIndex + 1]) }) })));
}
