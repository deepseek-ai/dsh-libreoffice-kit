import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { assertOfficePixels, renderOfficeCliContent, renderOfficeContent, verifyFontCacheContent } from './runtime-render-content.mjs';

function image(background, paint = () => {}) {
  const png = new PNG({ width: 100, height: 80 });
  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      png.data.set(paint(x, y) ?? background, (y * png.width + x) * 4);
    }
  }
  return PNG.sync.write(png);
}

function blocks(x, y) {
  if (y >= 10 && y < 40 && x >= 10 && x < 45) return [215, 48, 39, 255];
  if (y >= 10 && y < 40 && x >= 55 && x < 90) return [35, 111, 194, 255];
  if (y >= 55 && y < 60 && x >= 10 && x < 90) return [0, 0, 0, 255];
}

test('Office pixel qualification accepts visible blocks and text over white or transparent backgrounds', () => {
  for (const background of [[255, 255, 255, 255], [0, 0, 0, 0]]) {
    const result = assertOfficePixels(image(background, blocks), 'positive control');
    assert.equal(result.redPixels, 1050);
    assert.equal(result.bluePixels, 1050);
    assert.equal(result.darkPixels, 400);
    assert.equal(result.visiblePixels, 2500);
    assert.ok(result.redCenterX < result.blueCenterX);
  }
});

test('Office pixel qualification rejects white, transparent, and border-only images', () => {
  for (const bytes of [image([255, 255, 255, 255]), image([0, 0, 0, 0]),
    image([255, 255, 255, 255], (x, y) => blocks(x, y)?.map((channel, index) => index === 3 ? 0 : channel)),
    image([255, 255, 255, 255], (x, y) => x === 0 || y === 0 || x === 99 || y === 79 ? [0, 0, 0, 255] : undefined)]) {
    assert.throws(() => assertOfficePixels(bytes, 'negative control'), /blank|lacks red\/blue/);
  }
});

test('Office pixel qualification rejects missing text and swapped red/blue channels', () => {
  assert.throws(() => assertOfficePixels(image([255, 255, 255, 255], (x, y) => y < 40 ? blocks(x, y) : undefined), 'no text'), /lacks dark text/);
  assert.throws(() => assertOfficePixels(image([255, 255, 255, 255], (x, y) => {
    const pixel = blocks(x, y);
    return pixel && [pixel[2], pixel[1], pixel[0], pixel[3]];
  }), 'swapped channels'), /red\/blue/);
  assert.throws(() => assertOfficePixels(image([255, 255, 255, 255], (x, y) => blocks(99 - x, y)), 'mirrored blocks'), /positions are reversed/);
});

test('Office qualification retains later format results when earlier pixels or engine calls fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office-render-content-test-'));
  const directory = join(root, 'rendering');
  const calls = [];
  try {
    await assert.rejects(renderOfficeContent({ backend: 'native', async renderImages(request) {
      const extension = request.inputPath.split('.').at(-1);
      calls.push(extension);
      if (extension === 'xlsx') throw new Error('Calc painting failed');
      await mkdir(request.outputDir);
      const path = join(request.outputDir, 'page.png');
      await writeFile(path, image([255, 255, 255, 255], extension === 'pptx' ? blocks : undefined));
      return { backend: 'native', rasterEngine: 'libreoffice', source: 'saved', pageCount: 1,
        images: [{ path, width: 100, height: 80 }] };
    } }, directory, 'native'), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /blank/);
      assert.equal(error.errors[1].message, 'Calc painting failed');
      return true;
    });
    assert.deepEqual(calls, ['docx', 'xlsx', 'pptx']);
    assert.match(await readFile(join(directory, 'docx.error.txt'), 'utf8'), /blank/);
    assert.match(await readFile(join(directory, 'xlsx.error.txt'), 'utf8'), /Calc painting failed/);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(directory, 'pixels.json'), 'utf8'))), ['pptx']);
    assert.equal(JSON.parse(await readFile(join(directory, 'pptx.json'), 'utf8')).rasterEngine, 'libreoffice');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('CLI qualification preserves literal paths and selection flags, rejects exit failures, and saves diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office CLI 测试 & '));
  try {
    for (const fail of [false, true]) {
      const cliPath = join(root, `test CLI ${fail}.mjs`);
      await writeFile(cliPath, `import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const args = process.argv.slice(2);
const input = args[args.indexOf('--input') + 1];
const output = args[args.indexOf('--output-dir') + 1];
await writeFile(input + '.args.json', JSON.stringify(args));
if (${fail} && input.endsWith('.xlsx')) {
  process.stderr.write('Calc CLI rejected this input');
  process.exitCode = 3;
} else {
  await mkdir(output);
  const path = join(output, 'page.png');
  await writeFile(path, Buffer.from('${image([255, 255, 255, 255], blocks).toString('base64')}', 'base64'));
  process.stderr.write('CLI rendering diagnostic');
  process.stdout.write(JSON.stringify({ backend: 'native', rasterEngine: 'libreoffice', source: 'saved', pageCount: 1, images: [{ path, width: 100, height: 80 }] }));
}
`);
      const directory = join(root, `rendering-${fail}`);
      const result = renderOfficeCliContent(cliPath, directory, 'native');
      if (fail) {
        await assert.rejects(result, error => error instanceof AggregateError && error.errors.length === 1 && error.errors[0].code === 3);
        assert.equal(await readFile(join(directory, 'xlsx.cli.stderr.txt'), 'utf8'), 'Calc CLI rejected this input');
      } else assert.deepEqual(Object.keys(await result), ['docx', 'xlsx', 'pptx']);
      for (const extension of ['docx', 'xlsx', 'pptx']) {
        const input = join(directory, `color-blocks.${extension}`);
        assert.deepEqual(JSON.parse(await readFile(`${input}.args.json`, 'utf8')), [
          'render', '--input', input, '--output-dir', join(directory, `${extension}-images`), '--dpi', '72', '--timeout-ms', '90000',
          ...(extension === 'xlsx' ? ['--sheet', 'Render', '--range', 'A1:B2'] : ['--pages', '1']),
        ]);
      }
      assert.equal(await readFile(join(directory, 'pptx.cli.stderr.txt'), 'utf8'), 'CLI rendering diagnostic');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('cache qualification uses fresh disk readers and one warm converter, rejecting changed pixels or font reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'font-cache-render-content-'));
  try {
    for (const changed of ['none', 'pixels', 'font-report']) {
      const created = [];
      const factory = async options => {
        const index = created.length;
        const record = { options, renders: 0, disposed: 0 };
        created.push(record);
        const missingFonts = changed === 'font-report' && index === 2 ? ['Changed font'] : [];
        return {
          backend: 'native',
          async render({ outputPath }) {
            record.renders++;
            await writeFile(outputPath, '%PDF-fixture');
            if (options.fontMetadataCacheDirectory !== false) {
              await mkdir(options.fontMetadataCacheDirectory, { recursive: true });
              await writeFile(join(options.fontMetadataCacheDirectory, 'font-metadata.json'), '{}');
            }
            return { backend: 'native', missingFonts };
          },
          async renderImages(request) {
            await mkdir(request.outputDir);
            const path = join(request.outputDir, 'page.png');
            await writeFile(path, image([255, 255, 255, 255], (x, y) => changed === 'pixels' && index === 2 && x === 50 && y === 50
              ? [0, 0, 0, 255] : blocks(x, y)));
            return { backend: 'native', rasterEngine: request.inputPath.endsWith('.pdf') ? 'pdfium' : 'libreoffice',
              source: 'saved', missingFonts, pageCount: 1, images: [{ path, width: 100, height: 80 }] };
          },
          async dispose() { record.disposed++; },
        };
      };
      const directory = join(root, changed);
      const result = verifyFontCacheContent(factory, directory, 'native');
      if (changed === 'none') {
        const content = await result;
        assert.equal(content.identical, true);
        assert.deepEqual(Object.keys(content.modes), ['disabled', 'empty', 'disk', 'memory']);
      } else await assert.rejects(result, error => error instanceof AggregateError && error.errors.length === 2
        && error.errors.every(mode => mode.errors.every(format => /font metadata caching changed/.test(format.message))));
      assert.deepEqual(created.map(record => record.options.fontMetadataCacheDirectory), [false, join(directory, 'cache'), join(directory, 'cache')]);
      assert.deepEqual(created.map(record => record.renders), [3, 3, 6]);
      assert.deepEqual(created.map(record => record.disposed), [1, 1, 1]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
