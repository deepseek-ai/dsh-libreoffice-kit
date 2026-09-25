/** Qualify native resource lookup across the Windows extended-path threshold. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { documentFixture } from '../test/runtime-fixture.mjs';
import { isMain } from './platform-matrix.mjs';

const exec = promisify(execFile);
const resources = {
  pptx: 'program\\program\\..\\share\\config\\soffice.cfg\\modules\\simpress\\ui\\tabviewbar.ui',
  xlsx: 'program\\program\\..\\share\\config\\soffice.cfg\\modules\\scalc\\ui\\inputbar.ui',
  docx: 'program\\program\\..\\share\\config\\soffice.cfg\\svt\\ui\\scrollbars.ui',
};

async function inspectPdf(path) {
  const task = getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: true, verbosity: 0 });
  try {
    const pdf = await task.promise;
    const text = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      text.push((await (await pdf.getPage(index)).getTextContent()).items.map(item => item.str ?? '').join(' '));
    }
    return { pages: pdf.numPages, text: text.join('\n') };
  } finally { await task.destroy(); }
}

/** Verify fresh DOCX/XLSX/PPTX conversions against the same engine at short and long resource paths. */
export async function verifyWindowsLongPaths(engine) {
  assert.equal(process.platform, 'win32');
  engine = resolve(engine);
  const manifest = JSON.parse(await readFile(join(engine, 'prebuilds.json'), 'utf8'));
  assert.equal(manifest.engine.kind, 'native');
  const root = await mkdtemp(join(tmpdir(), 'lo-path-'));
  const links = [];
  const cases = [];
  try {
    // A junction for the EXE can retain its long physical module path in Windows.
    const executable = join(root, 'libreoffice-kit.exe');
    await copyFile(join(engine, manifest.engine.executable), executable);
    const aliases = new Map();
    async function aliasAt(length) {
      if (aliases.has(length)) return aliases.get(length);
      assert(length > root.length + 1, 'The temporary root is too long for the resource boundary fixture');
      const path = join(root, 'a'.repeat(length - root.length - 1));
      await symlink(engine, path, 'junction');
      links.push(path);
      aliases.set(length, path);
      return path;
    }
    for (const [format, resource] of Object.entries(resources)) {
      const input = format === 'docx' ? documentFixture('Windows long path 42')
        : await readFile(new URL(`../test/fixtures/${format === 'xlsx' ? 'one-sheet.xlsx' : 'one-slide.pptx'}`, import.meta.url));
      let baseline;
      const lengths = [root.length + 8, 248 - resource.length - 1, 249 - resource.length - 1, 220];
      for (const [index, length] of lengths.entries()) {
        const alias = await aliasAt(length);
        const directory = join(root, `${format}-${index}`);
        await mkdir(directory);
        const inputPath = join(directory, `input.${format}`);
        const outputPath = join(directory, 'output.pdf');
        await writeFile(inputPath, input, { flag: 'wx' });
        const profile = join(directory, 'profile');
        await mkdir(profile);
        await exec(executable, ['--program-directory', join(alias, manifest.engine.programDirectory),
          '--input-path', inputPath, '--output-path', outputPath, '--profile-directory', profile,
          '--max-output-bytes', '50000000', '--max-image-resolution', '150', '--format', 'pdf', '--recalculate', 'false'],
        { timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        const pdf = await inspectPdf(outputPath);
        assert.equal(pdf.pages, 1, `${format}: expected a one-page PDF`);
        assert.ok(pdf.text.trim(), `${format}: expected extractable text`);
        if (baseline) assert.deepEqual(pdf, baseline, `${format}: long resources changed PDF content`);
        else baseline = pdf;
        cases.push({ format, engineRootLength: length, resourcePathLength: length + 1 + resource.length, ...pdf });
      }
    }
    return cases;
  } finally {
    // Remove only fixture-owned links before recursively deleting real directories.
    for (const path of links.reverse()) await unlink(path);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

if (isMain(import.meta.url)) console.log(JSON.stringify(await verifyWindowsLongPaths(process.argv[2])));
