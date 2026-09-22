/** Compare all PDF pages and direct images using private inputs and anonymous result summaries. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import threads from 'node:worker_threads';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { runMeasuredProcess } from './process.mjs';

const { values } = parseArgs({ options: { baseline: { type: 'string' }, candidate: { type: 'string' }, manifest: { type: 'string' },
  output: { type: 'string' }, child: { type: 'string' }, python: { type: 'string', default: 'python3' } } });
const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
if (values.child) {
  const job = JSON.parse(await fs.readFile(values.child, 'utf8'));
  let catalog, selected = [];
  const Worker = threads.Worker;
  threads.Worker = class extends Worker {
    constructor(...args) {
      super(...args);
      this.on('message', message => {
        if (message.kind === 'fonts') catalog = hash(message.faces);
        if (message.snapshot) catalog = hash(message.snapshot.faces);
        if (message.kind === 'font-cache') selected.push(hash(message.entries));
        if (message.ok && message.fonts) selected.push(hash({ files: message.fonts.map(path => hash(readFileSync(path))), substitutions: message.substitutions }));
      });
    }
  };
  syncBuiltinESMExports();
  const { createConverter } = await import(pathToFileURL(job.entry));
  const converter = await createConverter({ ...job.options, ...(job.mode.startsWith('baseline') ? {} : { fontMetadataCacheDirectory: job.mode === 'disabled' ? false : job.cache }) });
  try {
    for (let iteration = 0; iteration < (job.mode === 'memory' || job.mode.startsWith('baseline') ? 2 : 1); iteration++) {
      selected = [];
      const directory = join(job.output, String(iteration)); await fs.mkdir(directory, { mode: 0o700 });
      const result = await converter.render({ inputPath: job.input, outputPath: join(directory, 'output.pdf') });
      const pdfSelection = [...selected]; selected = [];
      const direct = await converter.renderImages({ inputPath: job.input, outputDir: join(directory, 'direct'), dpi: 96, maxPages: 1000 });
      await fs.writeFile(join(directory, 'observed.json'), JSON.stringify({ catalog, pdfSelection, directSelection: selected,
        missingFonts: result.missingFonts, directMissingFonts: direct.missingFonts }), { mode: 0o600 });
    }
  } finally { await converter.dispose(); }
} else {
  for (const key of ['baseline', 'candidate', 'manifest', 'output']) assert.ok(values[key], `Missing --${key}`);
  const output = resolve(values.output); await fs.mkdir(output, { mode: 0o700 });
  const inputs = JSON.parse(await fs.readFile(values.manifest, 'utf8'));
  assert.ok(inputs.every(input => /^[a-z0-9-]+$/.test(input.id)));
  const cases = [];
  for (const input of inputs) {
    const directory = join(output, input.id); await fs.mkdir(directory, { mode: 0o700 });
    const runs = [];
    for (const mode of ['baseline-0', 'baseline-1', 'empty', 'disk', 'memory', 'disabled']) {
      const work = join(directory, mode); await fs.mkdir(work, { mode: 0o700 });
      const job = { mode, entry: resolve(values[mode.startsWith('baseline') ? 'baseline' : 'candidate']), input: input.path,
        options: input.options ?? {}, output: work, cache: join(directory, 'cache') };
      const path = join(work, 'job.json'); await fs.writeFile(path, JSON.stringify(job), { mode: 0o600 });
      const result = await runMeasuredProcess(process.execPath, [fileURLToPath(import.meta.url), '--child', path], work, 240000);
      runs.push({ mode, exitCode: result.exitCode, killed: result.killed, failed: Boolean(result.failure) });
      process.stdout.write(`${input.id} ${mode}: ${result.exitCode === 0 ? 'completed' : 'failed (private log)'}\n`);
    }
    cases.push({ id: input.id, runs });
    await fs.writeFile(join(output, 'runs.json'), JSON.stringify(cases, null, 2));
  }
  const compared = spawnSync(values.python, [fileURLToPath(new URL('./font-cache-compare.py', import.meta.url)), output], { stdio: 'inherit' });
  assert.equal(compared.status, 0, 'Rendering differences or incomplete runs require investigation; see summary.json.');
}
