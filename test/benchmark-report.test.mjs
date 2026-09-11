/** Hand-computable samples exercise reporting; this file never measures LibreOffice performance. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, markdown } from '../benchmarks/report.mjs';
import { runMeasuredProcess } from '../benchmarks/process.mjs';

const names = ['native', 'wasm-cpu', 'wasm-webgpu', 'wasm-webgl2', 'wasm-webgl1'];
const variants = names.map(name => ({ name, expectedBackend: name === 'native' ? 'native' : 'wasm', gpu: name.startsWith('wasm-web') ? name.slice(5) : 'off' }));
const sha = value => createHash('sha256').update(value).digest('hex');
const sampleText = jobs => `${jobs.map(job => JSON.stringify(job)).join('\n')}\n`;

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-report-test-'));
  try {
    const results = join(root, 'results');
    await mkdir(results);
    await mkdir(join(root, 'inputs'));
    const fixtures = [{ file: 'report.docx', dimensions: 'Synthetic report statistics', expectsGpuWork: true },
      { file: 'sales.xlsx', dimensions: 'Synthetic image-free statistics', expectsGpuWork: false }];
    for (const item of fixtures) {
      const bytes = Buffer.from(`Synthetic report test input: ${item.file}`);
      item.sha256 = sha(bytes);
      item.bytes = bytes.length;
      await writeFile(join(root, 'inputs', item.file), bytes);
    }
    const manifest = join(root, 'fixtures.json');
    await writeFile(manifest, JSON.stringify(fixtures));
    await writeFile(join(results, 'environment.json'), JSON.stringify({ repetitions: 3, variants, timestamp: '2000-01-01T00:00:00Z',
      node: 'fixture', platform: 'fixture', arch: 'fixture', cpu: 'fixture', options: { maxImageResolution: 192 } }));
    const fresh = [[20, 40, 30], [100, 300, 200], [50, 70, 60], [90, 80, 100]];
    const reuse = [[3, 9, 6], [20, 60, 40], [10, 30, 20], [12, 36, 24]];
    const jobs = [];
    for (const item of fixtures) for (const [index, variant] of variants.entries()) for (const mode of ['fresh', 'reuse']) {
      for (let repetition = 0; repetition < (mode === 'fresh' ? 3 : 1); repetition++) {
        const unavailable = index === 4;
        const rows = unavailable ? [] : (mode === 'fresh' ? [fresh[index][repetition]] : [1000, ...reuse[index]]).map((totalMs, iteration) => {
          const gpu = variant.gpu === 'off' ? (index === 0 ? 'native' : 'cpu') : variant.gpu;
          const accelerated = variant.gpu !== 'off' && item.expectsGpuWork ? 2 : 0;
          return { iteration, createMs: iteration === 0 ? 2 : 0, renderMs: totalMs - (iteration === 0 ? 2 : 0), totalMs,
            pdfBytes: 10, pdfSha256: sha('fake-pdf'), backend: variant.expectedBackend, missingFonts: [],
            outputPath: join(results, `${item.file}-${mode}-${repetition}-${variant.name}`, `${iteration}.pdf`),
            gpuWork: variant.gpu === 'off' ? 'disabled' : accelerated ? 'accelerated' : 'no-image-work',
            imageScaling: { backend: gpu, attempted: accelerated, accelerated, declined: 0, failed: 0 } };
        });
        jobs.push({ case: item.file, inputSha256: item.sha256, variant: variant.name, mode, repetition,
          exitCode: 0, exitSignal: null, killed: false, processTreePeakRssMiB: mode === 'fresh' ? [100, 300, 200][repetition] : 900,
          nodePeakRssMiB: 50, rssSamples: 10, status: unavailable ? 'unavailable' : 'complete', rows,
          ...(unavailable ? { unavailable: { requested: variant.gpu, reason: 'Controlled unavailable provider.' } } : {}) });
      }
    }
    await writeFile(join(results, 'samples.jsonl'), sampleText(jobs));
    await callback({ root, results, manifest, fixtures, jobs });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('report computes medians and ratios, keeps whole-job memory singular, and emits all raw clocks', async () => {
  await fixture(async ({ results, manifest, jobs }) => {
    const summary = await summarize({ results, manifest });
    const gpu = summary.cases[0].variants[2];
    assert.deepEqual(gpu.fresh.totalMs, { count: 3, median: 60, min: 50, max: 70, values: [50, 70, 60] });
    assert.deepEqual(gpu.reuse.subsequentRenderMs, { count: 3, median: 20, min: 10, max: 30, values: [10, 30, 20] });
    assert.equal(gpu.reuse.firstTotalMs, 1000);
    assert.deepEqual(gpu.fresh.memory.processTreeWholeJobPeakMiB, { count: 3, median: 200, min: 100, max: 300, values: [100, 300, 200] });
    assert.equal(gpu.reuse.memory.processTreeWholeJobPeakMiB.count, 1);
    assert.equal(gpu.reuse.memory.processTreeWholeJobPeakMiB.median, 900);
    assert.deepEqual(gpu.ratios.cpuMedianOverVariantMedian, { fresh: 200 / 60, reuseSubsequent: 2 });
    assert.deepEqual(gpu.ratios.nativeMedianOverVariantMedian, { fresh: 0.5, reuseSubsequent: 0.3 });
    const absent = summary.cases[0].variants[4];
    assert.equal(absent.fresh.totalMs, null);
    assert.equal(absent.reuse.subsequentRenderMs, null);
    assert.equal(absent.ratios.cpuMedianOverVariantMedian, null);
    assert.equal(absent.unavailable.length, 4);
    assert.deepEqual(summary.cases[1].variants[2].imageWork, ['no-image-work']);
    assert.equal(summary.cases.flatMap(item => item.variants.flatMap(entry => entry.rawJobs)).length, jobs.length);
    const report = markdown(summary);
    assert.match(report, /60\.00 \[50\.00, 70\.00\]/);
    assert.match(report, /0: 2\.00 \/ 998\.00 \/ 1000\.00/);
    assert.match(report, /no-image-work/);
    assert.match(report, /every render starts a fresh native process or WASM Worker/);
  });
});

test('missing, duplicate, failed, mismatched and falsely accelerated samples cannot produce a report', async () => {
  await fixture(async ({ results, manifest, jobs, root }) => {
    const cases = [
      [copy => copy.pop(), /Missing job/],
      [copy => copy.push(copy[0]), /Duplicate job/],
      [copy => { copy[0].exitCode = 1; }, /Failed job/],
      [copy => { copy[0].killed = true; }, /Killed job/],
      [copy => { copy[0].failure = 'controlled cleanup failure'; }, /Failed job/],
      [copy => { copy[0].inputSha256 = sha('other-input'); }, /Sample input hash differs/],
      [copy => copy[3].rows.pop(), /Missing or extra iterations/],
      [copy => { copy[0].rows[0].totalMs = NaN; }, /totalMs must be finite/],
      [copy => { copy[0].rows[0].outputPath = join(root, 'outside.pdf'); }, /PDF paths must identify fresh files/],
      [copy => { copy[8].rows[0].imageScaling.backend = 'cpu'; }, /requested image backend/],
      [copy => { copy[8].rows[0].imageScaling.accelerated = 0; copy[8].rows[0].imageScaling.attempted = 0; }, /require measured GPU work/],
      [copy => { copy[16].rows = [copy[0].rows[0]]; }, /Unavailable jobs must not contribute/],
    ];
    for (const [mutate, expected] of cases) {
      const copy = structuredClone(jobs);
      mutate(copy);
      await writeFile(join(results, 'samples.jsonl'), sampleText(copy));
      await assert.rejects(summarize({ results, manifest }), expected);
    }
    await writeFile(join(results, 'samples.jsonl'), sampleText(jobs));
    await writeFile(join(root, 'inputs', 'report.docx'), 'changed input');
    await assert.rejects(summarize({ results, manifest }), /Input hash changed/);
  });
});

test('partial GPU availability excludes lucky timings while retaining raw jobs and sampling gaps', async () => {
  await fixture(async ({ results, manifest, jobs }) => {
    jobs[8] = { ...jobs[8], status: 'unavailable', rows: [], unavailable: { requested: 'webgpu', reason: 'Controlled transient absence.' } };
    jobs[9].sampleFailure = 'Controlled ps failure.';
    jobs[10].rssSamples = 0;
    jobs[10].processTreePeakRssMiB = null;
    await writeFile(join(results, 'samples.jsonl'), sampleText(jobs));
    const gpu = (await summarize({ results, manifest })).cases[0].variants[2];
    assert.equal(gpu.status, 'unavailable');
    assert.equal(gpu.fresh.totalMs, null);
    assert.equal(gpu.reuse.subsequentRenderMs, null);
    assert.equal(gpu.rawJobs.flatMap(job => job.rows).length, 6);
    assert.equal(gpu.fresh.memory.samplingProblems.length, 2);
    assert.equal(gpu.fresh.memory.processTreeWholeJobPeakMiB.count, 2);
  });
});

test('report CLI writes reviewable files exclusively and preserves existing reports', { timeout: 15_000 }, async () => {
  await fixture(async ({ root, results, manifest }) => {
    const args = [fileURLToPath(new URL('../benchmarks/report.mjs', import.meta.url)), '--results', results, '--manifest', manifest];
    const first = join(root, 'first');
    await mkdir(first);
    const outcome = await runMeasuredProcess(process.execPath, args, first, 5_000);
    assert.equal(outcome.killed, false);
    assert.equal(outcome.exitCode, 0, await readFile(join(first, 'stderr.log'), 'utf8'));
    const original = await readFile(join(results, 'report.md'), 'utf8');
    assert.equal(JSON.parse(await readFile(join(results, 'summary.json'), 'utf8')).cases.length, 2);
    const second = join(root, 'second');
    await mkdir(second);
    const duplicate = await runMeasuredProcess(process.execPath, args, second, 5_000);
    assert.equal(duplicate.killed, false);
    assert.equal(duplicate.exitCode, 1);
    assert.match(await readFile(join(second, 'stderr.log'), 'utf8'), /EEXIST/);
    assert.equal(await readFile(join(results, 'report.md'), 'utf8'), original);
  });
});
