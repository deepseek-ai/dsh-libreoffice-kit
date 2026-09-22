import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpawnOptions } from 'node:child_process'
import { renderImagesWithNative } from '../src/native-image-renderer.ts'
import { resolveImageRender } from '../src/image-operations.ts'
import { resolveOptions } from '../src/options.ts'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (file: string, args: readonly string[], options: SpawnOptions) =>
    actual.spawn(process.execPath, [file, ...args], options) }
})

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

it.each(['text', 'pdf'] as const)('renders a native %s tile through the private helper protocol', async documentType => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-native-images-'))
  roots.push(root)
  const inputPath = join(root, documentType === 'pdf' ? 'input.pdf' : 'input.docx')
  const outputDir = join(root, 'images')
  const scratch = join(root, 'scratch')
  const profile = join(root, 'profile')
  await writeFile(inputPath, documentType === 'pdf' ? '%PDF-1.7 fixture' : 'office fixture')
  await Promise.all([mkdir(outputDir), mkdir(scratch)])
  const helper = join(root, 'helper.cjs')
  await writeFile(helper, `
const fs = require('node:fs')
const readline = require('node:readline')
const pathApi = require('node:path')
const args = process.argv.slice(2)
const value = name => args[args.indexOf(name) + 1]
const pdf = value('--input-path').endsWith('.pdf')
console.log(JSON.stringify(pdf
  ? { ok: true, kind: 'ready', documentType: 'pdf', tileMode: 0, pages: [{ width: 150, height: 150 }] }
  : { ok: true, kind: 'ready', documentType: 'text', tileMode: 0, writerRectangles: '0,0,150,150' }))
readline.createInterface({ input: process.stdin }).on('line', line => {
  if (line === 'DONE') { console.log(JSON.stringify({ ok: true, kind: 'done' })); process.exit(0) }
  const [, index, , width, height] = line.split(' ').map(Number)
  const path = pathApi.join(value('--scratch-directory'), 'tile-' + index + '.rgba')
  fs.writeFileSync(path, Buffer.alloc(width * height * 4, 255))
  console.log(JSON.stringify({ ok: true, kind: 'paint', index, path, width, height }))
})
`, { mode: 0o700 })
  const operation = resolveImageRender({ inputPath, outputDir, dpi: 96 })
  const result = await renderImagesWithNative({
    engine: { backend: 'native', root, programDirectory: root, executable: helper },
    options: resolveOptions({ fontDirectories: [] }), inputPath, source: await readFile(inputPath),
    scratch, profile, fonts: [], substitutions: [], missingFonts: [], operation,
    signal: new AbortController().signal,
  })
  expect(result).toMatchObject({ backend: 'native', rasterEngine: documentType === 'pdf' ? 'pdfium' : 'libreoffice',
    pageCount: 1, images: [{ index: 1, width: 10, height: 10 }] })
  expect((await readFile(result.images[0]!.path)).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
})
