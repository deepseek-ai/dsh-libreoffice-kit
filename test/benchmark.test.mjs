import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMeasuredProcess } from '../benchmarks/process.mjs';

test('benchmark transports results independently of engine stdout and records unavailable GPU paths without timings', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-benchmark-transport-'));
  try {
    await mkdir(join(root, 'inputs'));
    const input = Buffer.from('transport-only fixture');
    await writeFile(join(root, 'inputs/fixture.docx'), input);
    await writeFile(join(root, 'fixtures.json'), JSON.stringify([{ file: 'fixture.docx', sha256: createHash('sha256').update(input).digest('hex'), expectsGpuWork: true }]));
    for (const backend of ['native', 'wasm']) {
      await writeFile(join(root, `${backend}.mjs`), `import {writeFile} from 'node:fs/promises';
export async function createConverter(options){return {backend:${JSON.stringify(backend)},async dispose(){},async render({outputPath}){
console.log('Thread name: fixture noise');
if(options.gpu==='webgl1'){const error=new Error('fixture provider unavailable');error.code='unavailable';throw error;}
await writeFile(outputPath,'%PDF-1.7\\ntransport fixture\\n%%EOF',{flag:'wx'});
return {backend:${JSON.stringify(backend)},missingFonts:[],imageScaling:{backend:options.gpu==='webgpu'?'webgpu':'cpu',attempted:1,accelerated:options.gpu==='webgpu'?1:0,declined:0,failed:0}};
}};}
`);
    }
    const output = join(root, 'results');
    const measured = await runMeasuredProcess(process.execPath, [fileURLToPath(new URL('../benchmarks/convert.mjs', import.meta.url)), '--manifest', join(root, 'fixtures.json'), '--output', output,
      '--native-entry', join(root, 'native.mjs'), '--wasm-entry', join(root, 'wasm.mjs'), '--repetitions', '1'], root, 20_000);
    assert.equal(measured.exitCode, 0, await readFile(join(root, 'stderr.log'), 'utf8'));
    const samples = (await readFile(join(output, 'samples.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(samples.length, 10);
    for (const sample of samples) {
      if (['wasm-webgl1', 'wasm-webgl2'].includes(sample.variant)) {
        assert.equal(sample.status, 'unavailable');
        assert.deepEqual(sample.rows, []);
      } else {
        assert.equal(sample.status, 'complete');
        assert.ok(sample.rows.length > 0);
        if (sample.variant === 'wasm-webgpu') assert.ok(sample.rows.every(row => row.gpuWork === 'accelerated'));
      }
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
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  } finally { await rm(root, { recursive: true, force: true }); }
});
