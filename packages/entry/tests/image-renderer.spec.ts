import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderImagesWithWasm } from '../src/image-renderer.ts'
import { resolveImageRender } from '../src/image-operations.ts'
import { resolveOptions } from '../src/options.ts'
import type { WasmEngine } from '../src/engine.ts'
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(extension: string) {
  const root = await mkdtemp(join(tmpdir(), 'kit-image-engine-')); roots.push(root)
  const outputDir = join(root, 'images'); await mkdir(outputDir)
  const log = join(root, 'calls.jsonl')
  const loader = join(root, 'loader.cjs')
  await writeFile(loader, `const fs = require('node:fs')
module.exports = async function factory(options) {
  const type = ${extension === 'xlsx' ? 1 : extension === 'pptx' ? 2 : 0}
  const memory = new Uint32Array(100000)
  const strings = new Map(); let nextString = 8, next = 1024
  const text = value => { const p=nextString++;strings.set(p,value);return p }
  const module = { FS: {mkdirTree(){},writeFile(){},readFile(){throw Error('No export file should exist')}}, ENV: {}, HEAPU32: memory,
    UTF8ToString(p){return strings.get(p)}, PThread:{terminateAllThreads(){fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['terminate'])+'\\n')}},
    ccall(name, ret, types, args) {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([name,...args])+'\\n')
      if (name === 'malloc') { const p=next;next += Math.ceil(args[0]/4)*4;return p }
      if (name === 'free') return 0
      if (name === 'dsh_lok_initialize') return 1
      if (name === 'dsh_lok_document_load') return 2
      if (name === 'dsh_pdf_open') return 3
      if (name === 'dsh_lok_document_type') return type
      if (name === 'dsh_lok_document_parts' || name === 'dsh_pdf_page_count') return 2
      if (name === 'dsh_pdf_page_size') { memory[args[2]/4]=300;memory[args[3]/4]=150;return 1 }
      if (name === 'dsh_lok_document_page_rectangles') return text('0,0,300,150;0,200,300,150')
      if (name === 'dsh_lok_document_part_info') return text(JSON.stringify({name:['Data','Hidden'][args[1]],visible:args[1]===0?1:0,rtllayout:0,lastcolumn:1,lastrow:1}))
      if (name === 'dsh_lok_document_command_values') {
        if(args[1] === '.uno:AllPageSize')return text(JSON.stringify({parts:[{width:300,height:150},{width:450,height:300}]}))
        if(args[1] === '.uno:SheetGeometryData')return text(JSON.stringify({columns:{sizes:'150:16383',hidden:'0:16383',filtered:'0:16383'},rows:{sizes:'150:1048575',hidden:'0:1048575',filtered:'0:1048575'}}))
        return text('{}')
      }
      if (name === 'dsh_lok_document_command') options.dshOnCallback(16, JSON.stringify({commandName:args[1],idleID:'node-raster'}))
      if (name === 'dsh_lok_document_paint' || name === 'dsh_pdf_paint') {
        const [doc,p,part,w,h]=args;const pixels=new Uint8Array(memory.buffer,p,w*h*4)
        for(let i=0;i<pixels.length;i+=4){pixels[i]=0;pixels[i+1]=10;pixels[i+2]=200;pixels[i+3]=255}
      }
      if (name === 'dsh_lok_document_tile_mode') return 1
      if (name.includes('export') || name.includes('save_pdf')) throw Error('Office raster must never export PDF')
      return 1
    }
  }
  options.preRun.forEach(hook=>hook(module));return module
}`)
  const data = join(root, 'soffice.data'); await writeFile(data, '')
  const engine: WasmEngine = { backend: 'wasm', root, loader, data, wasm: join(root, 'soffice.wasm'), metadata: join(root, 'soffice.data.js.metadata'), programDirectory: '/instdir/program' }
  const base = { engine, extension, bytes: new TextEncoder().encode(extension === 'pdf' ? '%PDF-1.7 fixture' : 'document'),
    options: resolveOptions({ fontDirectories: [], fontFallbacks: [] }), document: { families: new Map<string, string>(), codePoints: [] }, faces: [] }
  return { root, outputDir, log, base }
}
it.each(['docx', 'pptx', 'pdf'])('renders one saved %s model into the explicitly ordered page batch', async (extension) => {
  const { base, outputDir, root, log } = await fixture(extension)
  const result = await renderImagesWithWasm({ ...base, operation: resolveImageRender({ inputPath: join(root, `in.${extension}`), outputDir, pages: [2, 1], dpi: 96 }) })
  expect(result).toMatchObject({ source: 'saved', backend: 'wasm', pageCount: 2, rasterEngine: extension === 'pdf' ? 'pdfium' : 'libreoffice' })
  expect(result.images.map(image => image.page)).toEqual([2, 1])
  expect(await readdir(outputDir)).toHaveLength(2)
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as unknown[])
  const load = extension === 'pdf' ? 'dsh_pdf_open' : 'dsh_lok_document_load'
  expect(calls.filter(call => call[0] === load)).toHaveLength(1)
  expect(calls.some(call => String(call[0]).includes('export') || String(call[0]).includes('save_pdf'))).toBe(false)
  expect(calls.at(-1)).toEqual(['terminate'])
  expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/)
})
it('renders an explicit sheet/A1 crop and extends that same sheet viewport', async () => {
  const { base, outputDir, root, log } = await fixture('xlsx')
  const result = await renderImagesWithWasm({ ...base, operation: resolveImageRender({ inputPath: join(root, 'in.xlsx'), outputDir, sheet: 'Data', range: 'B2', dpi: 96 }) })
  expect(result.images[0]).toMatchObject({ sheet: 'Data', range: 'B2:B2', width: 10, height: 10, rectangle: { x: 10, y: 10, width: 10, height: 10 } })
  expect(result.images[0]?.page).toBeUndefined()
  expect(await readFile(log, 'utf8')).toContain('.uno:ViewRowColumnHeaders?x=150&y=150&width=150&height=150')
})
it('rejects an oversized complete batch before painting anything and releases the engine', async () => {
  const { base, outputDir, root, log } = await fixture('pdf')
  await expect(renderImagesWithWasm({ ...base, operation: resolveImageRender({ inputPath: join(root, 'in.pdf'), outputDir, maxPages: 1 }) })).rejects.toThrow(/maxPages/)
  expect(await readdir(outputDir)).toEqual([])
  const calls = await readFile(log, 'utf8')
  expect(calls).not.toContain('dsh_pdf_paint')
  expect(calls).toContain('dsh_pdf_destroy')
})
