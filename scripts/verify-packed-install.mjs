/** Rehearse consumer installation without registry access or source-checkout resolution. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { npm, npmEnvironment, pnpm, run } from './pack-utils.mjs';
import { assert, sha256, verifyEnginePackage } from './verify-artifacts.mjs';
import { auditMacOS } from './audit-macos.mjs';
import { verifyKitPackage } from './verify-kit.mjs';
import { hostTarget, isMain, kitDirectory, readJson, root, tarballName } from './platform-matrix.mjs';
import { materializeEngineArchive } from './engine-archive.mjs';

/**
 * Resolve the adapter tarball the rehearsal installs: the candidate directory's
 * own pack when the release staged one, otherwise `pnpm pack` of the built
 * workspace adapter, which substitutes the `workspace:*` engine ranges with the
 * exact engine versions; installation supplies prepared local archives.
 * @param directory - Release candidate directory.
 * @param work - Scratch directory holding the isolated npm configuration.
 * @returns the adapter manifest and the tarball to install.
 */
export function packAdapter(directory, work) {
  const adapterDirectory = kitDirectory();
  const manifest = readJson(join(adapterDirectory, 'package.json'));
  const staged = join(directory, tarballName(manifest));
  if (existsSync(staged)) return { manifest, file: staged };
  for (const entry of ['lib/index.js', 'lib/worker.js'])
    assert(existsSync(join(adapterDirectory, entry)), `Build the Node API before rehearsal: missing ${entry}`);
  const destination = join(work, 'adapters');
  mkdirSync(destination);
  pnpm(['--dir', adapterDirectory, 'pack', '--pack-destination', destination],
    { cwd: adapterDirectory, env: { ...process.env, ...npmEnvironment(work) } });
  const file = join(destination, tarballName(manifest));
  assert(existsSync(file), `The adapter pack produced no ${file}`);
  return { manifest, file };
}

/** Qualify the host engine; Linux development rehearsals may explicitly retain both engines. */
export function verifyPackedInstall(directory, options = {}) {
  const wasmOnly = options.wasmOnly ?? (!options.nativeOnly && process.platform === 'linux');
  const { nativeOnly = !wasmOnly, expectedBackend = wasmOnly ? 'wasm' : 'native', keep } = options;
  assert(!(wasmOnly && nativeOnly), 'wasmOnly and nativeOnly are mutually exclusive');
  assert(!wasmOnly || process.platform === 'linux', 'WASM installation is supported only on Linux');
  if (keep) assert(!existsSync(keep), `Retained installation destination already exists: ${keep}`);
  const release = readJson(join(directory, 'release.json'));
  assert(release.schemaVersion === 1, 'Unsupported release manifest');
  const platform = hostTarget();
  if (!wasmOnly) assert(platform && release.platforms.includes(platform), `Release lacks host package ${platform}`);
  const selected = release.packages.filter((record) => [...(nativeOnly ? [] : ['wasm']), ...(wasmOnly ? [] : [platform])].includes(record.platform));
  assert(selected.length === (wasmOnly || nativeOnly ? 1 : 2), 'Release manifest omits an installed engine');
  for (const record of [...release.packages, ...release.dependencies]) {
    assert(sha256(join(directory, record.file)) === record.sha256, `Tarball checksum mismatch: ${record.file}`);
  }
  const work = mkdtempSync(join(tmpdir(), 'libreoffice-kit-install-'));
  try {
    const installs = selected.map(record => ({ ...record, file: materializeEngineArchive(directory, record, join(work, 'engines')) }));
    const adapter = packAdapter(directory, work);
    const consumer = join(work, 'consumer');
    mkdirSync(consumer);
    writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ name: 'libreoffice-kit-install-smoke', version: '0.0.0', private: true, type: 'module',
      overrides: Object.fromEntries(selected.map(record => [record.name, `$${record.name}`])),
      dependencies: Object.fromEntries(installs.map(record => [record.name, `file:${record.file}`])
        .concat(release.dependencies.map(record => [record.name, `file:${join(directory, record.file)}`]))
        .concat([[adapter.manifest.name, `file:${adapter.file}`]])),
    }, null, 2)}\n`);
    npm(['install', '--offline', '--ignore-scripts', '--package-lock=false', '--omit=optional'], consumer, work);
    for (const record of selected) verifyEnginePackage(join(consumer, 'node_modules', ...record.name.split('/')));
    const macOS = !wasmOnly && process.platform === 'darwin' ? auditMacOS(join(consumer, 'node_modules', '@deepseek-ai', `libreoffice-kit-${platform}`)) : undefined;
    verifyKitPackage(join(consumer, 'node_modules', ...adapter.manifest.name.split('/')), true);
    cpSync(join(root, 'scripts/smoke-installed.mjs'), join(consumer, 'smoke.mjs'));
    cpSync(join(root, 'test/runtime-linked-fixture.mjs'), join(consumer, 'runtime-linked-fixture.mjs'));
    cpSync(join(root, 'test/runtime-embedded-pdf-fixture.mjs'), join(consumer, 'runtime-embedded-pdf-fixture.mjs'));
    cpSync(join(root, 'test/fixtures'), join(consumer, 'fixtures'), { recursive: true });
    run(process.execPath, ['smoke.mjs', expectedBackend], { cwd: consumer,
      env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, timeout: 180_000 });
    const result = readJson(join(consumer, 'smoke-result.json'));
    const windowsLongPaths = process.platform === 'win32' ? JSON.parse(run(process.execPath,
      [join(root, 'scripts/verify-windows-long-paths.mjs'), join(consumer, 'node_modules', '@deepseek-ai', `libreoffice-kit-${platform}`)],
      { timeout: 240_000, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } })) : undefined;
    assert(result.backend === expectedBackend && result.pdfBytes > 100, 'Installed conversion did not return the expected PDF/backend');
    assert(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].every(format => result.formats?.[format]?.backend === result.backend && result.formats[format].pdfBytes > 100),
      'Installed conversion must include DOC, DOCX, XLS, XLSX, PPT, and PPTX PDFs');
    assert(result.embeddedGraphics?.pdfInEmf === true, 'Installed conversion must preserve embedded PDF graphics');
    if (keep) {
      mkdirSync(dirname(keep), { recursive: true });
      for (const file of ['smoke.mjs', 'runtime-linked-fixture.mjs', 'runtime-embedded-pdf-fixture.mjs', 'smoke-result.json', 'roundtrip.docx', 'roundtrip.pdf', 'roundtrip.doc.pdf', 'roundtrip.xls.pdf', 'roundtrip.ppt.pdf', 'roundtrip.xlsx.pdf', 'roundtrip.pptx.pdf', 'external.docx', 'external.pdf', 'embedded-pdf.docx', 'embedded-pdf.pdf'])
        rmSync(join(consumer, file));
      rmSync(join(consumer, 'fixtures'), { recursive: true });
      try { renameSync(consumer, keep); }
      catch (error) {
        if (error.code !== 'EXDEV') throw error;
        try { cpSync(consumer, keep, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false }); }
        catch (error) { rmSync(keep, { recursive: true, force: true }); throw error; }
      }
    }
    // Record the installed adapter so a receipt proves which build converted.
    const adapterRecord = { name: adapter.manifest.name, version: adapter.manifest.version,
      file: basename(adapter.file), sha256: sha256(adapter.file) };
    return { ...result, ...(windowsLongPaths ? { windowsLongPaths } : {}), ...(macOS ? { macOS } : {}), adapter: adapterRecord, installedOutsideRepository: true, network: 'offline', ...(keep ? { retainedInstallation: keep } : {}) };
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
}

if (isMain(import.meta.url)) {
  const directory = resolve(process.argv[2] ?? join(root, '.release/npm'));
  const keepIndex = process.argv.indexOf('--keep');
  if (keepIndex !== -1) assert(process.argv[keepIndex + 1] && !process.argv[keepIndex + 1].startsWith('--'), '--keep requires a destination path');
  const mode = process.argv.includes('--wasm-only') ? { wasmOnly: true, nativeOnly: false }
    : process.argv.includes('--native-only') ? { nativeOnly: true, wasmOnly: false } : {};
  assert(!(process.argv.includes('--wasm-only') && process.argv.includes('--native-only')), 'wasmOnly and nativeOnly are mutually exclusive');
  console.log(JSON.stringify(verifyPackedInstall(directory, { ...mode, ...(keepIndex === -1 ? {} : { keep: resolve(process.argv[keepIndex + 1]) }) })));
}
