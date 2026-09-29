/** Shared visible-content checks for real Office renders and offline release rehearsals. */
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PNG } from 'pngjs';
import { assertRenderingEvidence, assertRenderingPixels } from '../scripts/rendering-evidence.mjs';
const executeFile = promisify(execFile);

/** Decode PNG pixels, composite transparency onto white, and check the fixture's colored blocks and text. */
export function assertOfficePixels(bytes, label) {
  const { width, height, data } = PNG.sync.read(bytes);
  let visiblePixels = 0, redPixels = 0, bluePixels = 0, darkPixels = 0, redX = 0, blueX = 0;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] / 255;
    const r = 255 + (data[index] - 255) * alpha;
    const g = 255 + (data[index + 1] - 255) * alpha;
    const b = 255 + (data[index + 2] - 255) * alpha;
    const x = (index / 4) % width;
    if (Math.min(r, g, b) < 240) visiblePixels++;
    if (r >= 160 && g <= 100 && b <= 100) { redPixels++; redX += x; }
    if (r <= 100 && g <= 160 && b >= 160) { bluePixels++; blueX += x; }
    if (Math.max(r, g, b) < 80) darkPixels++;
  }
  const metrics = { width, height, visiblePixels, redPixels, bluePixels, darkPixels,
    redCenterX: redPixels === 0 ? null : redX / redPixels,
    blueCenterX: bluePixels === 0 ? null : blueX / bluePixels };
  assertRenderingPixels(metrics, label);
  return metrics;
}

/** Render one repository-authored page, slide, and worksheet through the selected engine, without PDF fallback. */
export async function renderOfficeContent(converter, directory, expectedBackend) {
  assert.equal(converter.backend, expectedBackend);
  return renderContent(request => converter.renderImages(request), directory, expectedBackend, 'node');
}

/** Invoke the selected package's CLI with literal arguments and verify the same saved Office pixels. */
export async function renderOfficeCliContent(cliPath, directory, expectedBackend) {
  return renderContent(async request => {
    const args = [cliPath, 'render', '--input', request.inputPath, '--output-dir', request.outputDir, '--dpi', String(request.dpi), '--timeout-ms', '90000',
      ...(request.sheet === undefined ? ['--pages', request.pages.join(',')] : ['--sheet', request.sheet, '--range', request.range])];
    const outputPrefix = request.outputDir.replace(/-images$/, '.cli');
    let output;
    try {
      output = await executeFile(process.execPath, args, { encoding: 'utf8', timeout: 100_000, maxBuffer: 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } });
    } catch (error) {
      await writeFile(`${outputPrefix}.stdout.txt`, error.stdout ?? '');
      await writeFile(`${outputPrefix}.stderr.txt`, error.stderr ?? '');
      throw error;
    }
    await writeFile(`${outputPrefix}.stdout.txt`, output.stdout);
    await writeFile(`${outputPrefix}.stderr.txt`, output.stderr);
    return JSON.parse(output.stdout);
  }, directory, expectedBackend, 'cli');
}

async function renderContent(render, directory, expectedBackend, entryPoint) {
  await mkdir(directory);
  const results = {};
  const errors = [];
  for (const extension of ['docx', 'xlsx', 'pptx']) {
    try {
      const inputPath = join(directory, `color-blocks.${extension}`);
      await writeFile(inputPath, await readFile(new URL(`./fixtures/color-blocks.${extension}`, import.meta.url)));
      const result = await render({ inputPath, outputDir: join(directory, `${extension}-images`), dpi: 72,
        ...(extension === 'xlsx' ? { sheet: 'Render', range: 'A1:B2' } : { pages: [1] }) });
      await writeFile(join(directory, `${extension}.json`), `${JSON.stringify(result, null, 2)}\n`);
      assert.equal(result.backend, expectedBackend, `${extension} changed engines`);
      assert.equal(result.rasterEngine, 'libreoffice', `${extension} must paint Office pixels directly`);
      assert.equal(result.source, 'saved');
      assert.equal(result.pageCount, 1);
      assert.equal(result.images.length, 1);
      const saved = result.images[0];
      const metrics = assertOfficePixels(await readFile(saved.path), `${entryPoint} ${expectedBackend} ${extension}`);
      assert.equal(metrics.width, saved.width);
      assert.equal(metrics.height, saved.height);
      results[extension] = { backend: result.backend, rasterEngine: result.rasterEngine, ...metrics };
    } catch (error) {
      errors.push(error);
      await writeFile(join(directory, `${extension}.error.txt`), `${error.stack ?? error}\n`);
    }
  }
  await writeFile(join(directory, 'pixels.json'), `${JSON.stringify(results, null, 2)}\n`);
  if (process.env.LIBREOFFICE_RENDER_ARTIFACTS) {
    const destination = resolve(process.env.LIBREOFFICE_RENDER_ARTIFACTS);
    await mkdir(destination, { recursive: true });
    const artifact = await mkdtemp(join(destination, `office-${expectedBackend}-${entryPoint}-`));
    await cp(directory, join(artifact, 'rendering'), { recursive: true });
    console.log(`Office render artifacts: ${artifact}`);
  }
  if (errors.length) throw new AggregateError(errors, `Office rendering failed for ${errors.length} format(s): ${errors.map(error => error.message).join('; ')}`);
  assertRenderingEvidence(results, expectedBackend);
  return results;
}
