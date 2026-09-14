import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runMeasuredProcess } from '../benchmarks/process.mjs';

test('benchmark children omit ambient credentials and Node overrides while retaining locale settings', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-benchmark-environment-'));
  try {
    const moduleUrl = new URL('../benchmarks/process.mjs', import.meta.url).href;
    const childScript = `process.stdout.write(JSON.stringify({ secretAbsent:process.env.KIT_TEST_SECRET===undefined,
      nodeOptionsAbsent:process.env.NODE_OPTIONS===undefined, unrelatedAbsent:process.env.KIT_TEST_UNRELATED===undefined,
      localeSecretAbsent:process.env.LC_SECRET===undefined, locale:process.env.LANG, timezone:process.env.TZ }));`;
    const controller = `import {runMeasuredProcess} from ${JSON.stringify(moduleUrl)};
      const result=await runMeasuredProcess(process.execPath,['-e',${JSON.stringify(childScript)}],${JSON.stringify(root)},5000);
      if(result.exitCode!==0||result.killed||result.failure)throw new Error(JSON.stringify(result));`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', controller], {
      env: { ...process.env, KIT_TEST_SECRET: 'synthetic-secret', KIT_TEST_UNRELATED: 'synthetic-override',
        LC_SECRET: 'synthetic-secret', NODE_OPTIONS: '--no-warnings', LANG: 'C', TZ: 'UTC' }, timeout: 10_000,
    });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'stdout.log'), 'utf8')), {
      secretAbsent: true, nodeOptionsAbsent: true, unrelatedAbsent: true, localeSecretAbsent: true, locale: 'C', timezone: 'UTC',
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('benchmark transports results independently of engine stdout', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-benchmark-transport-'));
  try {
    await mkdir(join(root, 'inputs'));
    const input = Buffer.from('transport-only fixture');
    await writeFile(join(root, 'inputs/fixture.docx'), input);
    await writeFile(join(root, 'fixtures.json'), JSON.stringify([{ file: 'fixture.docx', sha256: createHash('sha256').update(input).digest('hex') }]));
    for (const backend of ['native', 'wasm']) {
      await writeFile(join(root, `${backend}.mjs`), `import {writeFile} from 'node:fs/promises';
export async function createConverter(){return {backend:${JSON.stringify(backend)},async dispose(){},async render({outputPath}){
console.log('Thread name: fixture noise');
await writeFile(outputPath,'%PDF-1.7\\ntransport fixture\\n%%EOF',{flag:'wx'});
return {backend:${JSON.stringify(backend)},missingFonts:[]};
}};}
`);
    }
    const output = join(root, 'results');
    const measured = await runMeasuredProcess(process.execPath, [fileURLToPath(new URL('../benchmarks/convert.mjs', import.meta.url)), '--manifest', join(root, 'fixtures.json'), '--output', output,
      '--native-entry', join(root, 'native.mjs'), '--wasm-entry', join(root, 'wasm.mjs'), '--repetitions', '1'], root, 20_000);
    assert.equal(measured.exitCode, 0, await readFile(join(root, 'stderr.log'), 'utf8'));
    const samples = (await readFile(join(output, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(JSON.parse(await readFile(join(output, 'environment.json'), 'utf8')).childEnvironment.sanitized, true);
    assert.equal(samples.length, 4);
    for (const sample of samples) {
      assert.equal(sample.status, 'complete');
      assert.ok(sample.rows.length > 0);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('benchmark deadline kills descendants that retain the exited parent stdout pipe', { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-benchmark-group-'));
  try {
    const marker = join(root, 'descendant.json');
    const script = join(root, 'parent.cjs');
    await writeFile(script, `const {spawn}=require('node:child_process');const {writeFileSync}=require('node:fs');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid}));process.exit(0);
`);
    const outcome = await runMeasuredProcess(process.execPath, [script], root, 5_000);
    assert.equal(outcome.killed, true);
    assert.match(outcome.failure, /deadline/);
    const { pid } = JSON.parse(await readFile(marker, 'utf8'));
    try {
      const { stdout } = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'stat=']);
      // Linux init may retain an exited orphan as a zombie until its next waitpid.
      assert.match(stdout.trim(), /^Z/, `Benchmark descendant ${pid} is still running.`);
    } catch (error) {
      if (error.code !== 1 || error.stdout.trim() !== '') throw error;
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
