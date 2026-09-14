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

const variants = ['native', 'wasm-cpu'].map(name => ({ name, expectedBackend: name === 'native' ? 'native' : 'wasm' }));
const sha = value => createHash('sha256').update(value).digest('hex');
const sampleText = jobs => `${jobs.map(job => JSON.stringify(job)).join('\n')}\n`;

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-report-test-'));
  try {
    const results = join(root, 'results');
    await mkdir(results);
    await mkdir(join(root, 'inputs'));
    const fixtures = [{ file: 'report.docx', dimensions: 'Synthetic report statistics' },
      { file: 'sales.xlsx', dimensions: 'Synthetic image-free statistics' }];
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
    const fresh = [[20, 40, 30], [100, 300, 200]];
    const reuse = [[3, 9, 6], [20, 60, 40]];
    const jobs = [];
    for (const item of fixtures) for (const [index, variant] of variants.entries()) for (const mode of ['fresh', 'reuse']) {
      for (let repetition = 0; repetition < (mode === 'fresh' ? 3 : 1); repetition++) {
        const rows = (mode === 'fresh' ? [fresh[index][repetition]] : [1000, ...reuse[index]]).map((totalMs, iteration) => ({
          iteration, createMs: iteration === 0 ? 2 : 0, renderMs: totalMs - (iteration === 0 ? 2 : 0), totalMs,
          pdfBytes: 10, pdfSha256: sha('fake-pdf'), backend: variant.expectedBackend, missingFonts: [],
          outputPath: join(results, `${item.file}-${mode}-${repetition}-${variant.name}`, `${iteration}.pdf`),
        }));
        jobs.push({ case: item.file, inputSha256: item.sha256, variant: variant.name, mode, repetition,
          exitCode: 0, exitSignal: null, killed: false, processTreePeakRssMiB: mode === 'fresh' ? [100, 300, 200][repetition] : 900,
          nodePeakRssMiB: 50, rssSamples: 10, status: 'complete', rows });
      }
    }
    await writeFile(join(results, 'samples.jsonl'), sampleText(jobs));
    await callback({ root, results, manifest, fixtures, jobs });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('report computes medians and ratios, keeps whole-job memory singular, and emits all raw clocks', async () => {
  await fixture(async ({ results, manifest, jobs }) => {
    const summary = await summarize({ results, manifest });
    const wasm = summary.cases[0].variants[1];
    assert.deepEqual(wasm.fresh.totalMs, { count: 3, median: 200, min: 100, max: 300, values: [100, 300, 200] });
    assert.deepEqual(wasm.reuse.subsequentRenderMs, { count: 3, median: 40, min: 20, max: 60, values: [20, 60, 40] });
    assert.equal(wasm.reuse.firstTotalMs, 1000);
    assert.deepEqual(wasm.fresh.memory.processTreeWholeJobPeakMiB, { count: 3, median: 200, min: 100, max: 300, values: [100, 300, 200] });
    assert.equal(wasm.reuse.memory.processTreeWholeJobPeakMiB.count, 1);
    assert.equal(wasm.reuse.memory.processTreeWholeJobPeakMiB.median, 900);
    assert.deepEqual(wasm.ratios.nativeMedianOverVariantMedian, { fresh: 30 / 200, reuseSubsequent: 6 / 40 });
    assert.deepEqual(summary.cases[0].variants[0].ratios.nativeMedianOverVariantMedian, { fresh: 1, reuseSubsequent: 1 });
    assert.equal(summary.cases.flatMap(item => item.variants.flatMap(entry => entry.rawJobs)).length, jobs.length);
    const report = markdown(summary);
    assert.match(report, /200\.00 \[100\.00, 300\.00\]/);
    assert.match(report, /0: 2\.00 \/ 998\.00 \/ 1000\.00/);
    assert.match(report, /every render starts a fresh native process or WASM Worker/);
  });
});

test('missing, duplicate, failed and mismatched samples cannot produce a report', async () => {
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
      [copy => { copy[8].rows.pop(); }, /Missing or extra iterations/],
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

test('RSS sampling gaps stay explicit while the remaining samples aggregate', async () => {
  await fixture(async ({ results, manifest, jobs }) => {
    jobs[2].rssSamples = 0;
    jobs[2].processTreePeakRssMiB = null;
    jobs[3].sampleFailure = 'Controlled ps failure.';
    await writeFile(join(results, 'samples.jsonl'), sampleText(jobs));
    const native = (await summarize({ results, manifest })).cases[0].variants[0];
    assert.equal(native.rawJobs.flatMap(job => job.rows).length, 7);
    assert.equal(native.fresh.memory.samplingProblems.length, 1);
    assert.equal(native.reuse.memory.samplingProblems.length, 1);
    assert.equal(native.fresh.memory.processTreeWholeJobPeakMiB.count, 2);
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
