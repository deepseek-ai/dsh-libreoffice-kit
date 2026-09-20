#!/usr/bin/env node
/** Install and exercise the independent font archive with its exact offline JavaScript closure. */
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { npm, run } from './pack-utils.mjs';
import { isMain, readJson, root } from './platform-matrix.mjs';
import { verifyFontPackage } from './build-fonts.mjs';
import { verifyBrowserPreview } from './verify-browser-preview.mjs';

/** No native package, Node LibreOffice API, registry access or install hooks participate. */
export function verifyFontsInstall(directory) {
  const candidate = verifyBrowserPreview(directory);
  const work = mkdtempSync(join(tmpdir(), 'libreoffice-fonts-install-'));
  try {
    const consumer = join(work, 'consumer'); mkdirSync(consumer);
    const records = [...Object.values(candidate.packages), ...candidate.dependencies];
    writeFileSync(join(consumer, 'package.json'), `${JSON.stringify({ name: 'libreoffice-fonts-install-smoke', version: '0.0.0', private: true, type: 'module',
      dependencies: Object.fromEntries(records.map(record => [record.name, `file:${join(directory, record.file)}`])) }, null, 2)}\n`);
    npm(['install', '--offline', '--ignore-scripts', '--package-lock=false'], consumer, work);
    verifyFontPackage(join(consumer, 'node_modules/@deepseek-ai/libreoffice-kit'));
    mkdirSync(join(consumer, 'fixtures'));
    cpSync(join(root, 'packages/entry/tests/fixtures/fonts/LatinGreek.ttf'), join(consumer, 'fixtures/LatinGreek.ttf'));
    cpSync(join(root, 'scripts/smoke-installed-fonts.mjs'), join(consumer, 'smoke.mjs'));
    run(process.execPath, ['smoke.mjs'], { cwd: consumer, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    writeFileSync(join(consumer, 'consumer.ts'), "import { createFontSource, type FontMatchRequest } from '@deepseek-ai/libreoffice-kit/fonts';\nexport const source = createFontSource;\nexport type Request = FontMatchRequest;\n");
    writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify({ compilerOptions: { module: 'NodeNext', target: 'ES2024',
      strict: true, lib: ['ES2024', 'DOM'], types: [], noEmit: true }, files: ['consumer.ts'] }));
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(consumer, 'tsconfig.json')],
      { cwd: consumer, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' } });
    const result = { ...readJson(join(consumer, 'font-smoke.json')), publicTypes: true, archiveSha256: candidate.packages.kit.sha256, wasmSha256: candidate.packages.wasm.sha256 };
    mkdirSync(join(directory, 'evidence'), { recursive: true });
    writeFileSync(join(directory, 'evidence/fonts-install.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); }
}

if (isMain(import.meta.url)) console.log(JSON.stringify(verifyFontsInstall(resolve(process.argv[2])), null, 2));
