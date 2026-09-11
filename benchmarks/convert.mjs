#!/usr/bin/env node
/** Measure the public disk conversion API in fresh processes with identical generated inputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runMeasuredProcess } from './process.mjs';

const { values } = parseArgs({ options: {
  manifest: { type: 'string' }, output: { type: 'string' },
  'native-entry': { type: 'string' }, 'wasm-entry': { type: 'string' },
  repetitions: { type: 'string', default: '3' }, case: { type: 'string' },
  'child-job': { type: 'string' },
} });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const file = fileURLToPath(import.meta.url);

if (values['child-job']) {
  const job = JSON.parse(await readFile(values['child-job'], 'utf8'));
  const module = await import(pathToFileURL(job.entry).href);
  const start = performance.now();
  let converter;
  let unavailable;
  const rows = [];
  try {
    converter = await module.createConverter(job.options);
    const createMs = performance.now() - start;
    assert.equal(converter.backend, job.expectedBackend);
    for (let iteration = 0; iteration < job.count; iteration++) {
      const outputPath = join(job.output, `${iteration}.pdf`);
      const before = performance.now();
      const result = await converter.render({ inputPath: job.input, outputPath });
      const renderMs = performance.now() - before;
      let gpuWork = 'disabled';
      if (job.gpu !== 'off') {
        if (result.imageScaling.backend !== job.gpu || (job.expectsGpuWork && result.imageScaling.accelerated === 0)) {
          unavailable = { requested: job.gpu, observed: result.imageScaling, reason: result.imageScaling.reason ?? 'This image fixture did not perform the requested GPU image scaling.' };
          break;
        }
        gpuWork = result.imageScaling.accelerated > 0 ? 'accelerated' : 'no-image-work';
      }
      const pdf = await readFile(outputPath);
      assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
      rows.push({ iteration, renderMs, createMs: iteration === 0 ? createMs : 0,
        totalMs: renderMs + (iteration === 0 ? createMs : 0), pdfBytes: pdf.length,
        pdfSha256: hash(pdf), outputPath, gpuWork, ...result });
    }
  } catch (error) {
    if (job.gpu === 'off' || error.code !== 'unavailable') throw error;
    unavailable = { requested: job.gpu, reason: error.message };
  } finally { await converter?.dispose(); }
  await writeFile(join(job.output, 'result.json'), `${JSON.stringify({ status: unavailable ? 'unavailable' : 'complete',
    unavailable, rows: unavailable ? [] : rows, nodePeakRssMiB: process.resourceUsage().maxRSS / 1024 })}\n`, { flag: 'wx' });
} else {
  for (const name of ['manifest', 'output', 'native-entry', 'wasm-entry']) {
    if (!values[name]) throw new Error(`Missing --${name}.`);
  }
  const repetitions = Number(values.repetitions);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || 180000 * (repetitions + 1) > 0x7fffffff) throw new Error('repetitions must fit the positive Node deadline range.');
  const manifestPath = resolve(values.manifest);
  const output = resolve(values.output);
  await mkdir(output, { recursive: true });
  const all = JSON.parse(await readFile(manifestPath, 'utf8'));
  const fixtures = all.filter(fixture => !values.case || fixture.file === values.case);
  if (fixtures.length === 0) throw new Error('No selected fixture.');
  for (const fixture of fixtures) {
    assert.equal(basename(fixture.file), fixture.file, 'Fixture names must be plain filenames.');
    assert.ok(/^[\w.-]+\.(docx|xlsx|pptx)$/.test(fixture.file), 'Fixture extension must be OOXML.');
    assert.equal(typeof fixture.expectsGpuWork, 'boolean', 'Regenerate fixtures with explicit GPU-work expectations.');
  }
  const variants = [
    { name: 'native', entry: resolve(values['native-entry']), expectedBackend: 'native', gpu: 'off' },
    { name: 'wasm-cpu', entry: resolve(values['wasm-entry']), expectedBackend: 'wasm', gpu: 'off' },
    { name: 'wasm-webgpu', entry: resolve(values['wasm-entry']), expectedBackend: 'wasm', gpu: 'webgpu' },
    { name: 'wasm-webgl2', entry: resolve(values['wasm-entry']), expectedBackend: 'wasm', gpu: 'webgl2' },
    { name: 'wasm-webgl1', entry: resolve(values['wasm-entry']), expectedBackend: 'wasm', gpu: 'webgl1' },
  ];
  const options = { maxImageResolution: 192, timeoutMs: 120000, maxGpuBytes: 512 * 1024 * 1024,
    fontDirectories: process.platform === 'darwin' ? ['/System/Library/Fonts', '/Library/Fonts'] : undefined };
  if (options.fontDirectories === undefined) delete options.fontDirectories;
  await writeFile(join(output, 'environment.json'), `${JSON.stringify({ timestamp: new Date().toISOString(),
    node: process.version, platform: platform(), arch: process.arch, cpu: cpus()[0].model,
    logicalCpus: cpus().length, memoryGiB: totalmem() / 1024 ** 3, options, repetitions, variants,
    childEnvironment: { sanitized: true, policy: 'Only platform executable paths, home/temp paths, locale/timezone, and display connection settings are inherited. NODE_OPTIONS, credentials, and loader/driver overrides are excluded; values are not recorded.' },
    memory: 'Job-lifetime aggregate RSS of the benchmark child and descendants sampled every 100 ms; includes import, validation and disposal, excludes controller. Reuse rows share the whole-job peak. Node maxRSS includes its workers but excludes native child. Sampling failures are retained.',
    clock: 'createConverter + render to closed PDF output; excludes module import, PDF validation, disposal, network, and frontend rendering. OS disk cache is not cleared.',
    reuse: 'The same converter retains font metadata. Every render starts a new native process or WASM Worker.',
    unavailable: 'Explicit GPU variants without their requested backend or expected image work retain diagnostics and no timing rows. Image-free inputs measure adapter startup with gpuWork=no-image-work.',
  }, null, 2)}\n`, { flag: 'wx' });
  let ordinal = 0;
  for (const fixture of fixtures) {
    const input = join(dirname(manifestPath), 'inputs', fixture.file);
    assert.equal(hash(await readFile(input)), fixture.sha256, 'Input fixture changed.');
    for (const mode of ['fresh', 'reuse']) {
      for (let repetition = 0; repetition < (mode === 'fresh' ? repetitions : 1); repetition++) {
        const offset = ordinal++ % variants.length;
        for (const variant of [...variants.slice(offset), ...variants.slice(0, offset)]) {
          const label = `${fixture.file}-${mode}-${repetition}-${variant.name}`;
          const directory = join(output, label);
          await mkdir(directory);
          const job = { ...variant, options: { ...options, gpu: variant.gpu }, input, expectsGpuWork: fixture.expectsGpuWork,
            output: directory, count: mode === 'fresh' ? 1 : repetitions + 1 };
          const jobPath = join(directory, 'job.json');
          await writeFile(jobPath, JSON.stringify(job));
          const measured = await runMeasuredProcess(process.execPath, [file, '--child-job', jobPath], directory, 180000 * job.count);
          const outcome = { case: fixture.file, inputSha256: fixture.sha256, variant: variant.name, mode, repetition,
            ...measured };
          if (measured.exitCode === 0 && !measured.killed && !measured.failure) {
            try { Object.assign(outcome, JSON.parse(await readFile(join(directory, 'result.json'), 'utf8'))); }
            catch (error) { outcome.failure = `Missing or invalid benchmark result file: ${error}`; }
          }
          await appendFile(join(output, 'samples.jsonl'), `${JSON.stringify(outcome)}\n`);
          const succeeded = outcome.exitCode === 0 && !outcome.killed && !outcome.failure;
          process.stdout.write(`${label}: ${succeeded ? outcome.status : 'FAILED'}\n`);
          if (!succeeded) throw new Error(`Benchmark failed: ${label}; inspect ${directory}.`);
        }
      }
    }
  }
}
