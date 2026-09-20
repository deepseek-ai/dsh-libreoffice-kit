/** Installed browser receipts are verified against real files, hashes and symlinks. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import type { WasmEngine } from '../src/engine.ts'

const location = vi.hoisted(() => ({ root: '', resolveEngine: vi.fn(), windowsEscape: undefined as { root: string; file: string } | undefined }))
vi.mock('../src/engine.ts', () => ({ resolveEngine: location.resolveEngine }))
vi.mock('node:path', async importOriginal => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual,
    relative: (from: string, to: string) => from === location.windowsEscape?.root && to === location.windowsEscape.file
      ? actual.win32.relative('C:\\package', 'D:\\outside\\worker.js') : actual.relative(from, to),
    isAbsolute: (path: string) => location.windowsEscape ? actual.win32.isAbsolute(path) : actual.isAbsolute(path),
  }
})
vi.mock('node:url', async importOriginal => {
  const actual = await importOriginal<typeof import('node:url')>()
  return { ...actual, fileURLToPath: (url: string | URL) => String(url).endsWith('/src/browser-assets.ts')
    ? `${location.root}/src/browser-assets.ts` : actual.fileURLToPath(url) }
})

beforeEach(() => { vi.resetModules(); location.resolveEngine.mockReset(); location.windowsEscape = undefined })

const digest = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex')

async function installation() {
  const directory = await mkdtemp(join(tmpdir(), 'kit-browser-assets-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const root = join(directory, 'entry')
  const engineRoot = join(directory, 'wasm')
  await mkdir(join(root, 'lib/browser'), { recursive: true })
  await mkdir(join(engineRoot, 'assets'), { recursive: true })
  const workerBytes = 'self.onmessage = () => {};\n'
  const worker = { path: 'lib/browser/worker.js', bytes: Buffer.byteLength(workerBytes), sha256: digest(workerBytes) }
  const workerPath = join(root, worker.path)
  await writeFile(workerPath, workerBytes)
  const engine: WasmEngine = { backend: 'wasm', root: engineRoot, programDirectory: '/instdir/program',
    loader: join(engineRoot, 'assets/loader.mjs'), wasm: join(engineRoot, 'assets/engine.wasm'),
    data: join(engineRoot, 'assets/engine.data'), metadata: join(engineRoot, 'assets/metadata.json') }
  const hashes: Record<string, string> = {}
  for (const key of ['loader', 'wasm', 'data', 'metadata'] as const) {
    const bytes = key === 'wasm' ? new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]) : Buffer.from(`installed ${key}\n`)
    await writeFile(engine[key], bytes)
    hashes[relative(engine.root, engine[key]).split(sep).join('/')] = digest(bytes)
  }
  const writeReceipt = (value: unknown = { schemaVersion: 1, files: { worker } }) => writeFile(join(root, 'lib/browser/assets.json'), JSON.stringify(value))
  const writePrebuild = (value: unknown = { files: hashes }) => writeFile(join(engineRoot, 'prebuilds.json'), JSON.stringify(value))
  await writeReceipt()
  await writePrebuild()
  location.root = root
  location.resolveEngine.mockResolvedValue(engine)
  const { resolveBrowserAssets } = await import('../src/browser-assets.ts')
  return { directory, root, engine, worker, workerPath, workerBytes, hashes, writeReceipt, writePrebuild, resolveBrowserAssets }
}

it('returns exactly five immutable, hashed resources and shares in-flight installation validation', async () => {
  const f = await installation()
  const first = f.resolveBrowserAssets()
  expect(f.resolveBrowserAssets()).toBe(first)
  const assets = await first
  expect(assets).toMatchObject({ schemaVersion: 1, programDirectory: '/instdir/program' })
  expect(Object.keys(assets.files)).toEqual(['worker', 'loader', 'wasm', 'data', 'metadata'])
  expect(assets.files.worker).toEqual({ path: await realpath(f.workerPath), bytes: f.worker.bytes, sha256: f.worker.sha256 })
  for (const file of Object.values(assets.files)) {
    expect(Object.isFrozen(file)).toBe(true)
    expect(file.bytes).toBeGreaterThan(0)
  }
  for (const key of ['loader', 'wasm', 'data', 'metadata'] as const)
    expect(assets.files[key].sha256).toBe(f.hashes[relative(f.engine.root, f.engine[key]).split(sep).join('/')])
  expect(Object.isFrozen(assets)).toBe(true)
  expect(Object.isFrozen(assets.files)).toBe(true)
  expect(f.resolveBrowserAssets()).toBe(first)
  expect(location.resolveEngine).toHaveBeenCalledOnce()
})

it('clears a rejected installation promise so repaired resources can be validated again', async () => {
  const f = await installation()
  await writeFile(f.workerPath, 'x'.repeat(f.worker.bytes))
  const failed = f.resolveBrowserAssets()
  expect(f.resolveBrowserAssets()).toBe(failed)
  await expect(failed).rejects.toThrow('checksum differs')
  await writeFile(f.workerPath, f.workerBytes)
  const retried = f.resolveBrowserAssets()
  expect(retried).not.toBe(failed)
  await expect(retried).resolves.toMatchObject({ files: { worker: { sha256: f.worker.sha256 } } })
  expect(location.resolveEngine).toHaveBeenCalledTimes(2)
})

it('rejects a native engine without exposing browser resources', async () => {
  const f = await installation()
  location.resolveEngine.mockResolvedValue({ backend: 'native', root: f.engine.root, executable: '/helper', programDirectory: '/program' })
  await expect(f.resolveBrowserAssets()).rejects.toThrow('require the shared WASM engine')
})

it.each([
  { schemaVersion: 2, files: { worker: {} } },
  { schemaVersion: 1 },
  { schemaVersion: 1, files: {} },
  { schemaVersion: 1, files: { worker: {}, unexpected: {} } },
])('rejects an incompatible or non-exclusive Worker receipt (%#)', async receipt => {
  const f = await installation()
  await f.writeReceipt(receipt)
  await expect(f.resolveBrowserAssets()).rejects.toThrow('Invalid browser Worker receipt')
})

it.each([null, {}, { path: '../worker.js' }, { path: '/tmp/worker.js' }])('rejects a missing or redirected Worker entry (%#)', async worker => {
  const f = await installation()
  await f.writeReceipt({ schemaVersion: 1, files: { worker } })
  await expect(f.resolveBrowserAssets()).rejects.toThrow('Invalid browser Worker path')
})

it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '26'])('rejects malformed Worker byte counts: %j', async bytes => {
  const f = await installation()
  await f.writeReceipt({ schemaVersion: 1, files: { worker: { ...f.worker, bytes } } })
  await expect(f.resolveBrowserAssets()).rejects.toThrow('Invalid browser Worker receipt')
})

it('rejects a Worker whose declared byte count differs from the installed file', async () => {
  const f = await installation()
  await f.writeReceipt({ schemaVersion: 1, files: { worker: { ...f.worker, bytes: f.worker.bytes + 1 } } })
  await expect(f.resolveBrowserAssets()).rejects.toThrow('Invalid installed browser resource')
})

it.each([undefined, '', 'xyz', 'a'.repeat(63), 'A'.repeat(64)])('rejects an absent or malformed Worker SHA-256 (%#)', async sha256 => {
  const f = await installation()
  await f.writeReceipt({ schemaVersion: 1, files: { worker: { ...f.worker, sha256 } } })
  await expect(f.resolveBrowserAssets()).rejects.toThrow('Invalid installed browser resource')
})

it.each(['root', 'parent', 'outside', 'directory', 'empty', 'missing'] as const)('rejects a %s Worker target using its real filesystem identity', async target => {
  const f = await installation()
  await rm(f.workerPath)
  if (target === 'root') await symlink(f.root, f.workerPath)
  else if (target === 'parent') await symlink(f.directory, f.workerPath)
  else if (target === 'outside') {
    const path = join(f.directory, 'outside-worker.js')
    await writeFile(path, f.workerBytes)
    await symlink(path, f.workerPath)
  } else if (target === 'directory') await mkdir(f.workerPath)
  else if (target === 'empty') await writeFile(f.workerPath, '')
  await expect(f.resolveBrowserAssets()).rejects.toThrow(target === 'missing' ? /ENOENT/ : 'Invalid installed browser resource')
})

it('accepts in-package symlinks and exposes their canonical paths', async () => {
  const f = await installation()
  const actual = join(f.root, 'lib/browser/worker-real.js')
  await writeFile(actual, f.workerBytes)
  await rm(f.workerPath)
  await symlink(actual, f.workerPath)
  expect((await f.resolveBrowserAssets()).files.worker.path).toBe(await realpath(actual))
})

it('rejects a Windows symlink targeting another drive, whose relative path is absolute', async () => {
  const f = await installation()
  const outside = join(f.directory, 'outside-worker.js')
  await writeFile(outside, f.workerBytes)
  await rm(f.workerPath)
  await symlink(outside, f.workerPath)
  // Exercise Windows path semantics while file IO, symlink resolution and hashes remain real on this host.
  location.windowsEscape = { root: await realpath(f.root), file: await realpath(outside) }
  await expect(f.resolveBrowserAssets()).rejects.toThrow('Invalid installed browser resource')
})

it.each(['loader', 'wasm', 'data', 'metadata'] as const)('rejects an engine receipt missing %s', async key => {
  const f = await installation()
  delete f.hashes[relative(f.engine.root, f.engine[key]).split(sep).join('/')]
  await f.writePrebuild()
  await expect(f.resolveBrowserAssets()).rejects.toThrow(`Unreceipted WASM resource: ${key}`)
})

it('rejects an engine receipt with no files table', async () => {
  const f = await installation()
  await f.writePrebuild({})
  await expect(f.resolveBrowserAssets()).rejects.toThrow('Unreceipted WASM resource: loader')
})

it.each(['hash-format', 'hash-mismatch', 'empty', 'escape'] as const)('rejects a WASM resource with %s even when the Worker validates', async failure => {
  const f = await installation()
  const key = relative(f.engine.root, f.engine.wasm).split(sep).join('/')
  if (failure === 'hash-format') { f.hashes[key] = 'invalid'; await f.writePrebuild() }
  else if (failure === 'hash-mismatch') await writeFile(f.engine.wasm, new Uint8Array([0, 97, 115, 109, 2, 0, 0, 0]))
  else if (failure === 'empty') await writeFile(f.engine.wasm, '')
  else {
    const outside = join(f.directory, 'outside.wasm')
    await writeFile(outside, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    await rm(f.engine.wasm)
    await symlink(outside, f.engine.wasm)
  }
  await expect(f.resolveBrowserAssets()).rejects.toThrow(failure === 'hash-mismatch' ? 'checksum differs' : 'Invalid installed browser resource')
})
