#!/usr/bin/env node
/** Validate complete benchmark evidence and report same-machine conversion comparisons. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const variants = [
  { name: 'native', expectedBackend: 'native', gpu: 'off' },
  { name: 'wasm-cpu', expectedBackend: 'wasm', gpu: 'off' },
  { name: 'wasm-webgpu', expectedBackend: 'wasm', gpu: 'webgpu' },
  { name: 'wasm-webgl2', expectedBackend: 'wasm', gpu: 'webgl2' },
  { name: 'wasm-webgl1', expectedBackend: 'wasm', gpu: 'webgl1' },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const number = (value, name, minimum = 0) => assert.ok(Number.isFinite(value) && value >= minimum, `${name} must be finite and >= ${minimum}.`);
const integer = (value, name, minimum = 0) => assert.ok(Number.isSafeInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}.`);
const digest = value => assert.match(value, /^[a-f0-9]{64}$/, 'Expected a SHA-256 digest.');
const stats = values => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { count: values.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1), values: [...values] };
};

function validateRow(row, iteration, variant, fixture) {
  assert.equal(row.iteration, iteration, 'Rows must contain each iteration in order.');
  number(row.renderMs, 'renderMs', Number.MIN_VALUE);
  number(row.createMs, 'createMs');
  number(row.totalMs, 'totalMs', Number.MIN_VALUE);
  if (iteration > 0) assert.equal(row.createMs, 0, 'Only the first iteration creates a converter.');
  assert.ok(Math.abs(row.totalMs - row.renderMs - row.createMs) <= 1e-6, 'totalMs must equal createMs + renderMs.');
  assert.equal(row.backend, variant.expectedBackend, 'Wrong conversion backend.');
  integer(row.pdfBytes, 'pdfBytes', 5);
  digest(row.pdfSha256);
  assert.equal(typeof row.outputPath, 'string');
  const gpu = row.imageScaling;
  assert.equal(gpu?.backend, variant.gpu === 'off' ? (variant.expectedBackend === 'native' ? 'native' : 'cpu') : variant.gpu,
    'A timing sample must use its requested image backend.');
  for (const key of ['attempted', 'accelerated', 'declined', 'failed']) integer(gpu[key], `imageScaling.${key}`);
  assert.equal(gpu.attempted, gpu.accelerated + gpu.declined + gpu.failed, 'Image operation counters disagree.');
  if (variant.gpu !== 'off') {
    if (fixture.expectsGpuWork) assert.ok(gpu.accelerated > 0, 'Image fixtures require measured GPU work.');
    assert.equal(row.gpuWork, gpu.accelerated > 0 ? 'accelerated' : 'no-image-work');
  } else assert.equal(row.gpuWork, 'disabled');
}

function memory(jobs) {
  const values = jobs.map(job => job.processTreePeakRssMiB).filter(value => value !== null);
  return { processTreeWholeJobPeakMiB: stats(values), jobs: jobs.length,
    samplingProblems: jobs.filter(job => job.processTreePeakRssMiB === null || job.sampleFailure).map(job => ({
      mode: job.mode, repetition: job.repetition, samples: job.rssSamples, reason: job.sampleFailure ?? 'No RSS samples captured.',
    })), nodeWholeJobPeakMiB: stats(jobs.map(job => job.nodePeakRssMiB)) };
}

/**
 * Validate the full selected manifest against jobs and actual input bytes before aggregating.
 * Partial GPU availability retains raw evidence but excludes the variant from comparisons.
 * @param options Paths to the conversion results, fixture manifest, and optional exact case selection.
 * @returns A JSON-safe summary retaining every original job and timing.
 */
export async function summarize({ results, manifest, caseName }) {
  results = resolve(results);
  manifest = resolve(manifest);
  const environment = JSON.parse(await readFile(join(results, 'environment.json'), 'utf8'));
  const all = JSON.parse(await readFile(manifest, 'utf8'));
  assert.ok(Array.isArray(all) && all.length > 0, 'Fixture manifest must be nonempty.');
  const fixtures = all.filter(fixture => !caseName || fixture.file === caseName);
  assert.ok(fixtures.length > 0, 'No selected fixtures.');
  integer(environment.repetitions, 'environment.repetitions', 1);
  const repetitions = environment.repetitions;
  assert.deepEqual(environment.variants.map(({ name, expectedBackend, gpu }) => ({ name, expectedBackend, gpu })).sort((a, b) => a.name.localeCompare(b.name)),
    [...variants].sort((a, b) => a.name.localeCompare(b.name)), 'Environment must declare the five expected variants.');
  const fixtureMap = new Map();
  for (const fixture of fixtures) {
    assert.equal(basename(fixture.file), fixture.file, 'Fixture names must be plain filenames.');
    assert.match(fixture.file, /^[\w.-]+\.(docx|xlsx|pptx)$/);
    assert.equal(typeof fixture.expectsGpuWork, 'boolean');
    digest(fixture.sha256);
    assert.ok(!fixtureMap.has(fixture.file), 'Duplicate fixture in manifest.');
    const bytes = await readFile(join(dirname(manifest), 'inputs', fixture.file));
    assert.equal(hash(bytes), fixture.sha256, `Input hash changed: ${fixture.file}.`);
    if (fixture.bytes !== undefined) assert.equal(bytes.length, fixture.bytes, 'Fixture byte count changed.');
    fixtureMap.set(fixture.file, fixture);
  }
  const source = await readFile(join(results, 'samples.jsonl'), 'utf8');
  const jobs = source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const seen = new Set();
  const outputPaths = new Set();
  for (const job of jobs) {
    const fixture = fixtureMap.get(job.case);
    assert.ok(fixture, `Unexpected case: ${job.case}.`);
    const variant = variants.find(variant => variant.name === job.variant);
    assert.ok(variant, `Unexpected variant: ${job.variant}.`);
    assert.ok(['fresh', 'reuse'].includes(job.mode), 'Unexpected sample mode.');
    integer(job.repetition, 'repetition');
    assert.ok(job.repetition < (job.mode === 'fresh' ? repetitions : 1), 'Unexpected repetition.');
    const key = `${job.case}/${job.variant}/${job.mode}/${job.repetition}`;
    assert.ok(!seen.has(key), `Duplicate job: ${key}.`);
    seen.add(key);
    assert.equal(job.inputSha256, fixture.sha256, `Sample input hash differs: ${key}.`);
    assert.equal(job.exitCode, 0, `Failed job: ${key}.`);
    assert.equal(job.exitSignal, null, `Signalled job: ${key}.`);
    assert.equal(job.killed, false, `Killed job: ${key}.`);
    assert.ok(!job.failure, `Failed job: ${key}: ${job.failure}`);
    assert.ok(['complete', 'unavailable'].includes(job.status), `Invalid job status: ${key}.`);
    integer(job.rssSamples, 'rssSamples');
    if (job.rssSamples === 0) assert.equal(job.processTreePeakRssMiB, null, 'No RSS samples means no tree peak.');
    else number(job.processTreePeakRssMiB, 'processTreePeakRssMiB', Number.MIN_VALUE);
    number(job.nodePeakRssMiB, 'nodePeakRssMiB', Number.MIN_VALUE);
    assert.ok(Array.isArray(job.rows), 'Missing timing rows.');
    if (job.status === 'unavailable') {
      assert.notEqual(variant.gpu, 'off', 'Native and CPU failures are not GPU unavailability.');
      assert.equal(job.rows.length, 0, 'Unavailable jobs must not contribute timing rows.');
      assert.equal(job.unavailable?.requested, variant.gpu, 'Unavailable provider mismatch.');
      assert.equal(typeof job.unavailable?.reason, 'string', 'Unavailable jobs require a reason.');
    } else {
      assert.equal(job.rows.length, job.mode === 'fresh' ? 1 : repetitions + 1, `Missing or extra iterations: ${key}.`);
      for (const [iteration, row] of job.rows.entries()) {
        validateRow(row, iteration, variant, fixture);
        const expected = join(results, `${job.case}-${job.mode}-${job.repetition}-${job.variant}`, `${iteration}.pdf`);
        assert.equal(resolve(row.outputPath), expected, 'PDF paths must identify fresh files in their owned job directory.');
        assert.ok(!outputPaths.has(expected), 'PDF output was reused.');
        outputPaths.add(expected);
      }
    }
  }
  for (const fixture of fixtures) for (const variant of variants) for (const mode of ['fresh', 'reuse']) {
    for (let repetition = 0; repetition < (mode === 'fresh' ? repetitions : 1); repetition++) {
      const key = `${fixture.file}/${variant.name}/${mode}/${repetition}`;
      assert.ok(seen.has(key), `Missing job: ${key}.`);
    }
  }
  const cases = fixtures.map(fixture => {
    const entries = variants.map(variant => {
      const selected = jobs.filter(job => job.case === fixture.file && job.variant === variant.name);
      const fresh = selected.filter(job => job.mode === 'fresh').sort((a, b) => a.repetition - b.repetition);
      const reuse = selected.filter(job => job.mode === 'reuse');
      const unavailable = selected.filter(job => job.status === 'unavailable').map(job => ({ mode: job.mode, repetition: job.repetition, ...job.unavailable }));
      const available = unavailable.length === 0;
      return { variant: variant.name, status: available ? 'complete' : 'unavailable', unavailable,
        imageWork: [...new Set(selected.flatMap(job => job.rows.map(row => row.gpuWork)))],
        fresh: { totalMs: available ? stats(fresh.map(job => job.rows[0].totalMs)) : null, memory: memory(fresh) },
        reuse: { firstTotalMs: available ? reuse[0].rows[0].totalMs : null,
          subsequentRenderMs: available ? stats(reuse[0].rows.slice(1).map(row => row.renderMs)) : null, memory: memory(reuse) },
        rawJobs: selected };
    });
    const cpu = entries.find(entry => entry.variant === 'wasm-cpu');
    const native = entries.find(entry => entry.variant === 'native');
    for (const entry of entries) {
      entry.ratios = {};
      for (const [name, baseline] of [['cpu', cpu], ['native', native]]) {
        entry.ratios[`${name}MedianOverVariantMedian`] = entry.status === 'complete' ? {
          fresh: baseline.fresh.totalMs.median / entry.fresh.totalMs.median,
          reuseSubsequent: baseline.reuse.subsequentRenderMs.median / entry.reuse.subsequentRenderMs.median,
        } : null;
      }
    }
    return { fixture, variants: entries };
  });
  return { schemaVersion: 1, environment, manifestSha256: hash(await readFile(manifest)),
    methodology: {
      experiment: 'Same-machine descriptive benchmark of synthetic files; not a randomized business A/B experiment.',
      fresh: `${repetitions} separate processes; each sample includes createConverter plus one render to a closed PDF file.`,
      reuse: `One process and converter; exclude its first render and summarize the subsequent ${repetitions}. Only font metadata is reused; every render starts a fresh native process or WASM Worker.`,
      clockExclusions: 'Module import, PDF validation, converter disposal, network transfer, and frontend display are excluded. OS disk caches are not cleared.',
      memory: 'Aggregate RSS of the child and descendants sampled every 100 ms across the entire job, including import, validation and disposal. This is an observed peak, not retained memory. Reuse has one shared whole-job peak, not a separate peak for each render. The controller is excluded; Node maxRSS excludes native descendants.',
      availability: 'A variant with any unavailable job has no timing aggregate or ratio. Raw successful jobs remain available for audit. RSS sampling gaps are listed separately.',
      ratios: 'Baseline median milliseconds divided by variant median milliseconds; above 1 means the variant was faster.',
      imageFree: 'XLSX fixtures contain no image scaling; GPU rows marked no-image-work measure initialization overhead and CPU document work.',
    }, cases };
}

const cell = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('|', '\\|').replaceAll('\n', ' ');
const fixed = value => value === null ? '—' : value.toFixed(2);
const interval = value => value ? `${fixed(value.median)} [${fixed(value.min)}, ${fixed(value.max)}]` : 'unavailable';
const peak = value => value.processTreeWholeJobPeakMiB
  ? `${fixed(value.processTreeWholeJobPeakMiB.median)} / ${fixed(value.processTreeWholeJobPeakMiB.max)}${value.samplingProblems.length ? ' (incomplete sampling)' : ''}` : 'not sampled';

/** Format validated aggregates and all raw clocks as an English repository report. */
export function markdown(summary) {
  const env = summary.environment;
  const lines = ['# LibreOffice Kit conversion benchmark', '',
    ...Object.values(summary.methodology).flatMap(text => [text, '']),
    `Environment: ${cell(env.platform)} ${cell(env.arch)}, ${cell(env.cpu)}, ${cell(env.node)}; recorded ${cell(env.timestamp)}.`, '',
    ...(env.childEnvironment ? [`Child environment sanitized: ${cell(env.childEnvironment.sanitized)}. ${cell(env.childEnvironment.policy)}`, ''] : []),
    `Render options: \`${JSON.stringify(env.options).replaceAll('`', '\\u0060')}\`.`, '',
    'Latency is milliseconds, shown as median [minimum, maximum]. Memory is MiB, shown as median / maximum of whole-job tree peaks; the reuse column contains one job. Ratios use the median clocks described above.', '',
  ];
  for (const result of summary.cases) {
    lines.push(`## ${result.fixture.file}`, '', `${cell(result.fixture.dimensions ?? '')} Input SHA-256: \`${result.fixture.sha256}\`.`, '',
      '| Variant | Fresh total ms | Subsequent reuse render ms | Fresh tree peak MiB | Reuse whole-job peak MiB | Image work |',
      '| --- | ---: | ---: | ---: | ---: | --- |');
    for (const entry of result.variants) lines.push(`| ${entry.variant} | ${interval(entry.fresh.totalMs)} | ${interval(entry.reuse.subsequentRenderMs)} | ${entry.status === 'unavailable' ? 'unavailable' : peak(entry.fresh.memory)} | ${entry.status === 'unavailable' ? 'unavailable' : peak(entry.reuse.memory)} | ${cell(entry.status === 'unavailable' ? 'unavailable' : entry.imageWork.join(', '))} |`);
    lines.push('', '| Variant | CPU / variant fresh | Native / variant fresh | CPU / variant reuse | Native / variant reuse |', '| --- | ---: | ---: | ---: | ---: |');
    for (const entry of result.variants) {
      const cpu = entry.ratios.cpuMedianOverVariantMedian, native = entry.ratios.nativeMedianOverVariantMedian;
      lines.push(`| ${entry.variant} | ${fixed(cpu?.fresh ?? null)} | ${fixed(native?.fresh ?? null)} | ${fixed(cpu?.reuseSubsequent ?? null)} | ${fixed(native?.reuseSubsequent ?? null)} |`);
    }
    for (const entry of result.variants) for (const diagnostic of entry.unavailable) lines.push('', `${entry.variant} ${diagnostic.mode}/${diagnostic.repetition}: unavailable — ${cell(diagnostic.reason)}.`);
    lines.push('', 'Raw clocks below retain every iteration, including the excluded first reuse conversion. Each tuple is `create / render / total` ms; the JSON summary preserves full numeric precision, GPU diagnostics, file hashes, and sampler diagnostics.', '',
      '| Variant | Job | Iteration clocks (create / render / total ms) | Whole-job tree peak MiB | RSS samples |',
      '| --- | --- | --- | ---: | ---: |');
    for (const entry of result.variants) for (const job of entry.rawJobs) lines.push(`| ${entry.variant} | ${job.mode}/${job.repetition} | ${job.status === 'unavailable' ? 'unavailable' : job.rows.map(row => `${row.iteration}: ${fixed(row.createMs)} / ${fixed(row.renderMs)} / ${fixed(row.totalMs)}`).join('; ')} | ${fixed(job.processTreePeakRssMiB)} | ${job.rssSamples} |`);
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { results: { type: 'string' }, manifest: { type: 'string' }, output: { type: 'string' }, case: { type: 'string' } } });
  if (!values.results || !values.manifest) throw new Error('Usage: report.mjs --results DIR --manifest fixtures.json [--output DIR] [--case FILE]');
  const summary = await summarize({ results: values.results, manifest: values.manifest, caseName: values.case });
  const output = resolve(values.output ?? values.results);
  await mkdir(output, { recursive: true });
  const created = [];
  try {
    for (const [name, contents] of [['summary.json', `${JSON.stringify(summary, null, 2)}\n`], ['report.md', markdown(summary)]]) {
      const path = join(output, name);
      const handle = await open(path, 'wx', 0o600);
      created.push(path);
      try { await handle.writeFile(contents); } finally { await handle.close(); }
    }
  } catch (error) { await Promise.all(created.map(path => rm(path))); throw error; }
  process.stdout.write(`Validated ${summary.cases.length} cases × five variants; wrote ${output}/summary.json and report.md.\n`);
}
