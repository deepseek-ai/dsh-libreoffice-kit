/** A retained raster session must reach a real idle barrier and release every engine allocation. */
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withWasmSession, type WasmSession } from '../src/wasm.ts'
import { resolveOptions } from '../src/options.ts'
import { indexSystemFonts } from '../src/fonts.ts'
import type { WasmEngine } from '../src/engine.ts'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
interface Behavior { extension?: string; allocationFails?: boolean; pdfOpenFails?: boolean; commandFails?: boolean; pumpFails?: boolean; idleAfter?: number; pauseFirstPump?: boolean; timeoutMs?: number; preloadFonts?: boolean }
async function fixture(behavior: Behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kit-wasm-session-')); roots.push(root)
  const log = join(root, 'calls.jsonl'), loader = join(root, 'loader.cjs'), data = join(root, 'soffice.data')
  await writeFile(data, '')
  await writeFile(loader, `const fs=require('node:fs'), behavior=${JSON.stringify(behavior)};
module.exports=async options=>{
 const record=(name,args=[])=>fs.appendFileSync(${JSON.stringify(log)},JSON.stringify([name,...args])+'\\n');
 let pumps=0;
 const module={HEAPU32:new Uint32Array(1024),ENV:{},
  FS:{mkdirTree(){},writeFile(path,bytes){record('write',[path,bytes.length])}},
  UTF8ToString(){return 'session engine failure'},
  PThread:{terminateAllThreads(){record('terminate')}},
  ccall(name,ret,types,args){record(name,args);
   if(name==='dsh_lok_error')return 16;
   if(name==='malloc')return behavior.allocationFails?0:256;
   if(name==='dsh_pdf_open')return behavior.pdfOpenFails?0:3;
   if(name==='dsh_lok_initialize')return 1;
   if(name==='dsh_lok_document_load')return 2;
   if(name==='dsh_lok_document_command')return behavior.commandFails?0:1;
   if(name==='dsh_lok_pump'){
    pumps++;
    if(behavior.pumpFails)return -1;
    if(pumps===(behavior.idleAfter??1))options.dshOnCallback(16,JSON.stringify({commandName:'.uno:ReportWhenIdle',idleID:'node-raster'}));
    return behavior.pauseFirstPump&&pumps===1?0:1;
   }
   return 1;
  }};
 options.dshOnCallback(0,'ordinary document callback');
 options.dshOnCallback(16,'not JSON');
 options.dshOnCallback(16,JSON.stringify({commandName:'.uno:Other',idleID:'node-raster'}));
 options.dshOnCallback(16,JSON.stringify({commandName:'.uno:ReportWhenIdle',idleID:'different-owner'}));
 options.preRun.forEach(hook=>hook(module));return module;
}`)
  const engine: WasmEngine = { backend: 'wasm', root, loader, data, wasm: join(root, 'soffice.wasm'), metadata: join(root, 'soffice.metadata'), programDirectory: '/instdir/program' }
  const faces = behavior.preloadFonts ? indexSystemFonts({ directories: [join(import.meta.dirname, 'fixtures/fonts')], maxFiles: 20, maxFileBytes: 10000000 }) : []
  const options = resolveOptions({ fontDirectories: [], fontFallbacks: [], initialFontFamilies: faces.slice(0, 1).map(face => face.family), timeoutMs: behavior.timeoutMs ?? 100 })
  const request = { engine, bytes: new Uint8Array([1, 2, 3]), extension: behavior.extension ?? 'docx', options, faces,
    document: { families: new Map<string, string>(), codePoints: [] } }
  return { run: <T>(use: (session: WasmSession) => Promise<T> | T) => withWasmSession(request, use),
    calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as [string, ...unknown[]]) }
}
it('ignores unrelated callbacks, pumps queued work across turns, and tears down after the matching idle callback', async () => {
  const f = await fixture({ idleAfter: 10, pauseFirstPump: true })
  await f.run(async session => { await session.idle(); expect(session.missingFonts).toEqual([]) })
  const calls = await f.calls()
  expect(calls.filter(([name]) => name === 'dsh_lok_pump')).toHaveLength(10)
  expect(calls.slice(-3).map(([name]) => name)).toEqual(['dsh_lok_document_destroy', 'dsh_lok_destroy', 'terminate'])
})
it.each([
  [{ commandFails: true }, /session engine failure/],
  [{ pumpFails: true }, /session engine failure/],
  [{ idleAfter: 1000000, timeoutMs: 5 }, /raster idle barrier/],
] as const)('rejects failed or unresponsive raster idle barriers and releases the document %j', async (behavior, message) => {
  const f = await fixture(behavior)
  await expect(f.run(session => session.idle())).rejects.toThrow(message)
  expect((await f.calls()).slice(-3).map(([name]) => name)).toEqual(['dsh_lok_document_destroy', 'dsh_lok_destroy', 'terminate'])
})
it('mounts complete PDF fonts before opening and lets immutable PDF sessions skip the Office idle pump', async () => {
  const f = await fixture({ extension: 'pdf', preloadFonts: true })
  await f.run(async session => { expect(session.pdf).toBe(true); await session.idle() })
  const calls = await f.calls(), opened = calls.findIndex(([name]) => name === 'dsh_pdf_open')
  expect(calls.slice(0, opened).some(([name, path]) => name === 'write' && String(path).startsWith('/usr/share/fonts/dsh-pdfium/'))).toBe(true)
  expect(calls.some(([name]) => name === 'dsh_lok_pump' || name === 'dsh_lok_initialize')).toBe(false)
  expect(calls.slice(-2).map(([name]) => name)).toEqual(['dsh_pdf_destroy', 'terminate'])
})
it.each([{ allocationFails: true }, { pdfOpenFails: true }])('releases PDF input memory and workers if open fails %j', async behavior => {
  const f = await fixture({ extension: 'pdf', ...behavior })
  await expect(f.run(() => { throw new Error('Must never receive an unopened PDF') })).rejects.toThrow(/session engine failure/)
  const calls = await f.calls()
  if ('pdfOpenFails' in behavior) expect(calls.some(([name, pointer]) => name === 'free' && pointer === 256)).toBe(true)
  expect(calls.some(([name]) => name === 'dsh_pdf_destroy')).toBe(false)
  expect(calls.at(-1)).toEqual(['terminate'])
})
