/** Serial fresh-process cache comparison using the installed API and the shared RSS sampler. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { syncBuiltinESMExports } from 'node:module';
import threads from 'node:worker_threads';
import { runMeasuredProcess } from './process.mjs';

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string' }, manifest: { type: 'string' }, output: { type: 'string' },
  repetitions: { type: 'string', default: '7' }, child: { type: 'string' },
} });
const file = fileURLToPath(import.meta.url);
if (values.child) {
  const job = JSON.parse(await fs.readFile(values.child, 'utf8'));
  const workers = [];
  const Worker = threads.Worker;
  threads.Worker = class extends Worker {
    constructor(url, options) {
      super(url, { ...options, execArgv: ['--import', fileURLToPath(new URL('./font-cache-counts.mjs', import.meta.url))] });
      const row = { role: String(url).includes('font-snapshot-worker') ? 'metadata' : 'conversion', bytes: 0, calls: 0, metadataInspectCalls: 0, scans: 0 };
      workers.push(row);
      this.on('message', message => {
        if (message.benchmarkFontReads) Object.assign(row, message.benchmarkFontReads);
        if (message.kind === 'fonts' || message.snapshot) {
          row.scans++;
          row.metadataBytes = message.benchmarkFontReads.bytes;
        }
      });
    }
  };
  syncBuiltinESMExports();
  const module = await import(pathToFileURL(job.entry));
  const options = job.variant === 'baseline' ? {} : { fontMetadataCacheDirectory: job.cache };
  const memory = { before: process.memoryUsage() };
  const converters = [];
  const rows = [];
  const start = performance.now();
  try {
    for (let index = 0; index < job.concurrency; index++) converters.push(await module.createConverter(options));
    const createMs = performance.now() - start;
    for (let iteration = 0; iteration < job.iterations; iteration++) {
      const before = performance.now();
      const results = await Promise.all(converters.map(async (converter, index) => {
        const input = job.inputs[(iteration + index) % job.inputs.length];
        const outputPath = join(job.output, `${iteration}-${index}.pdf`);
        const result = await converter.render({ inputPath: input.path, outputPath });
        const pdf = await fs.readFile(outputPath);
        assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
        return { case: input.id, backend: result.backend, pdfBytes: pdf.length, missingFontCount: result.missingFonts.length };
      }));
      rows.push({ iteration, ms: performance.now() - before + (iteration === 0 ? createMs : 0), results });
    }
    memory.completed = process.memoryUsage();
    global.gc();
    memory.completedGc = process.memoryUsage();
  } finally { await Promise.all(converters.map(converter => converter.dispose())); }
  global.gc();
  memory.disposedGc = process.memoryUsage();
  await fs.writeFile(join(job.output, 'result.json'), JSON.stringify({ rows, workers, memory }), { flag: 'wx' });
} else {
  for (const key of ['baseline', 'candidate', 'manifest', 'output']) assert.ok(values[key], `Missing --${key}`);
  const repetitions = Number(values.repetitions);
  assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0);
  const output = resolve(values.output);
  await fs.mkdir(output, { mode: 0o700 });
  const inputs = JSON.parse(await fs.readFile(values.manifest, 'utf8'));
  assert.ok(inputs.length > 0 && inputs.every(input => /^[a-z0-9-]+$/.test(input.id)));
  const samples = [];
  const cache = join(output, 'cache');
  let ordinal = 0;
  async function run(variant, mode, repetition, selected, concurrency = 1, iterations = 1) {
    const directory = join(output, `job-${ordinal++}`);
    await fs.mkdir(directory, { mode: 0o700 });
    const job = { entry: resolve(values[variant]), variant, cache: mode.endsWith('empty') ? join(directory, 'empty-cache') : cache,
      inputs: selected, output: directory, concurrency, iterations };
    const path = join(directory, 'job.json');
    await fs.writeFile(path, JSON.stringify(job), { mode: 0o600 });
    const observed = await runMeasuredProcess(process.execPath, ['--expose-gc', file, '--child', path], directory, 180000 * iterations);
    assert.equal(observed.exitCode, 0, `Job ${ordinal - 1} failed; private logs remain in its output directory.`);
    assert.equal(observed.killed, false);
    assert.equal(observed.failure, undefined);
    const result = JSON.parse(await fs.readFile(join(directory, 'result.json'), 'utf8'));
    samples.push({ variant, mode, repetition, cases: selected.map(input => input.id), concurrency, ...observed, ...result });
    await fs.writeFile(join(output, 'samples.json'), JSON.stringify(samples, null, 2));
    process.stdout.write(`${variant} ${mode} ${selected.map(input => input.id).join(',')} ${repetition}: ${result.rows.map(row => Math.round(row.ms)).join('/')} ms\n`);
  }
  await run('candidate', 'prime', 0, [inputs[0]]);
  for (const input of inputs) {
    for (const mode of ['empty', 'disk']) {
      for (let repetition = 0; repetition < repetitions; repetition++) {
        for (const variant of repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) await run(variant, mode, repetition, [input]);
      }
    }
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const variant of repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) await run(variant, 'reuse', repetition, [input], 1, 2);
    }
  }
  for (const concurrency of [1, 2, 4]) {
    for (const mode of ['concurrent-empty', 'concurrent-disk']) {
      for (const variant of ['baseline', 'candidate']) await run(variant, mode, 0, inputs, concurrency, 2);
    }
  }
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const variant of repetition % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) await run(variant, 'different-documents', repetition, inputs, 1, inputs.length);
  }
  await fs.writeFile(join(output, 'environment.json'), JSON.stringify({ node: process.version, platform: process.platform,
    arch: process.arch, cpu: cpus()[0].model, memoryGiB: totalmem() / 1024 ** 3, repetitions,
    clock: 'createConverter plus render and PDF header read; module import, disposal and forced GC excluded. OS file cache unchanged.',
    memory: 'Whole-job process-tree RSS at 100ms; parent process memory at completion and after GC/disposal. No post-disposal RSS leak inference.',
    reads: 'Synchronous font read return bytes/calls, diagnostic instrumentation in both variants. Metadata and conversion Workers distinguished.' }, null, 2));
}
