/** Validate anonymous measurements and retain median/range summaries beside every raw sample. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directory = resolve(process.argv[2]);
const samples = JSON.parse(await fs.readFile(join(directory, 'samples.json'), 'utf8'));
const environment = JSON.parse(await fs.readFile(join(directory, 'environment.json'), 'utf8'));
assert.ok(environment.repetitions >= 7, 'At least seven alternating pairs are required.');
const cases = [...new Set(samples.flatMap(sample => sample.cases))];
const keys = new Set();
for (const sample of samples) {
  const key = JSON.stringify([sample.variant, sample.mode, sample.repetition, sample.cases, sample.concurrency]);
  assert.ok(!keys.has(key), 'Duplicate sample.'); keys.add(key);
  assert.equal(sample.exitCode, 0); assert.equal(sample.killed, false); assert.equal(sample.failure, undefined);
  assert.ok(sample.rows.every(row => Number.isFinite(row.ms) && row.ms > 0));
  if (sample.variant === 'candidate' && ['disk', 'reuse', 'different-documents', 'concurrent-disk'].includes(sample.mode)) {
    assert.equal(sample.workers.reduce((total, worker) => total + worker.metadataInspectCalls, 0), 0, 'An unchanged disk-hit font was inspected.');
  }
  if (sample.variant === 'candidate' && sample.mode.startsWith('concurrent-')) {
    assert.equal(sample.workers.reduce((total, worker) => total + worker.scans, 0), sample.rows.length, 'Concurrent operations did not share one scan per wave.');
  }
}
const distribution = values => {
  if (values.length === 0) return { n: 0, median: null, min: null, max: null };
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, min: sorted[0], max: sorted.at(-1) };
};
const summary = { environment, timings: [], concurrency: [] };
for (const mode of ['empty', 'disk', 'reuse', 'different-documents']) {
  for (const selected of mode === 'different-documents' ? [cases] : cases.map(id => [id])) {
    const row = { mode, cases: selected };
    for (const variant of ['baseline', 'candidate']) {
      const group = samples.filter(sample => sample.variant === variant && sample.mode === mode && JSON.stringify(sample.cases) === JSON.stringify(selected));
      assert.equal(group.length, environment.repetitions, 'Missing paired measurements.');
      assert.deepEqual(group.map(sample => sample.repetition).sort((a, b) => a - b), Array.from({ length: environment.repetitions }, (_, i) => i));
      row[variant] = {
        milliseconds: distribution(group.map(sample => mode === 'reuse' ? sample.rows[1].ms : sample.rows.reduce((sum, operation) => sum + operation.ms, 0))),
        firstOperationMilliseconds: distribution(group.map(sample => sample.rows[0].ms)),
        processTreePeakRssMiB: distribution(group.map(sample => sample.processTreePeakRssMiB).filter(value => value !== null)),
        completedHeapMiB: distribution(group.map(sample => sample.memory.completedGc.heapUsed / 1024 ** 2)),
        disposedArrayBuffersMiB: distribution(group.map(sample => sample.memory.disposedGc.arrayBuffers / 1024 ** 2)),
      };
    }
    row.candidateOverBaseline = row.candidate.milliseconds.median / row.baseline.milliseconds.median;
    summary.timings.push(row);
  }
}
for (const sample of samples.filter(sample => sample.mode.startsWith('concurrent-'))) {
  summary.concurrency.push({ variant: sample.variant, mode: sample.mode, converters: sample.concurrency,
    operationWavesMilliseconds: sample.rows.map(row => row.ms), processTreePeakRssMiB: sample.processTreePeakRssMiB,
    scans: sample.workers.reduce((sum, worker) => sum + worker.scans, 0),
    metadataInspectCalls: sample.workers.reduce((sum, worker) => sum + worker.metadataInspectCalls, 0),
    fontReadBytes: sample.workers.reduce((sum, worker) => sum + worker.bytes, 0),
    memory: sample.memory });
}
assert.equal(summary.concurrency.length, 12, 'Missing 1/2/4-converter empty/disk measurements.');
await fs.writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
for (const row of summary.timings) console.log(row.mode, row.cases.join(','),
  Math.round(row.baseline.milliseconds.median), '->', Math.round(row.candidate.milliseconds.median), 'ms');
