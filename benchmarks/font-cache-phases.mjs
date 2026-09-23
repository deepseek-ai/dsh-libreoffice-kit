/** Attribute repeated-operation validation cost without retaining font paths or Worker payloads. */
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import threads from 'node:worker_threads';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const { values } = parseArgs({ options: { candidate: { type: 'string' }, manifest: { type: 'string' }, cache: { type: 'string' }, output: { type: 'string' } } });
for (const key of ['candidate', 'manifest', 'cache', 'output']) assert.ok(values[key], `Missing --${key}`);
let scans = [];
const Worker = threads.Worker;
threads.Worker = class extends Worker {
  constructor(url, options) {
    const start = performance.now(); super(url, options);
    if (String(url).includes('font-snapshot-worker')) {
      const row = {}; scans.push(row);
      this.once('message', () => { row.messageMs = performance.now() - start; });
      this.once('exit', () => { row.joinedMs = performance.now() - start; });
    }
  }
};
syncBuiltinESMExports();
const { createConverter } = await import(pathToFileURL(resolve(values.candidate)));
const inputs = JSON.parse(await fs.readFile(values.manifest, 'utf8'));
const output = resolve(values.output); await fs.mkdir(output, { mode: 0o700 });
const results = [];
for (const input of inputs) {
  const converter = await createConverter({ fontMetadataCacheDirectory: resolve(values.cache) });
  try {
    for (let iteration = 0; iteration < 8; iteration++) {
      scans = []; const start = performance.now();
      const outputPath = join(output, `${input.id}-${iteration}.pdf`);
      await converter.render({ inputPath: input.path, outputPath });
      results.push({ case: input.id, iteration, milliseconds: performance.now() - start, scans });
      await fs.unlink(outputPath);
    }
  } finally { await converter.dispose(); }
}
await fs.writeFile(join(output, 'phases.json'), JSON.stringify(results, null, 2) + '\n', { flag: 'wx' });
