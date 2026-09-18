/** Resolve the browser Worker and the single installed WASM payload for a local asset server. */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveEngine } from './engine.ts'

/** A validated local resource. Servers should expose opaque URLs, not these filesystem paths. */
export interface BrowserAsset {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/** Exactly the resources consumed by the browser transport. */
export interface BrowserAssets {
  readonly schemaVersion: 1
  readonly programDirectory: string
  readonly files: Readonly<Record<'worker' | 'loader' | 'wasm' | 'data' | 'metadata', BrowserAsset>>
}

interface AssetReceipt {
  readonly schemaVersion: number
  readonly files: Readonly<Record<string, { readonly path: string; readonly bytes: number; readonly sha256: string }>>
}

let installation: Promise<BrowserAssets> | undefined

/** Validate package identity, resource paths, sizes, and hashes once for this immutable installation. */
export function resolveBrowserAssets(): Promise<BrowserAssets> {
  return installation ??= resolveAssets().catch(error => { installation = undefined; throw error })
}

async function resolveAssets(): Promise<BrowserAssets> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const engine = await resolveEngine()
  if (engine.backend !== 'wasm') throw new Error('Browser assets require the shared WASM engine')
  const receipt = JSON.parse(await readFile(join(root, 'lib/browser/assets.json'), 'utf8')) as AssetReceipt
  if (receipt.schemaVersion !== 1 || Object.keys(receipt.files ?? {}).join(',') !== 'worker')
    throw new Error('Invalid browser Worker receipt')
  const worker = receipt.files.worker
  if (worker?.path !== 'lib/browser/worker.js') throw new Error('Invalid browser Worker path')
  const prebuild = JSON.parse(await readFile(join(engine.root, 'prebuilds.json'), 'utf8')) as { files: Record<string, string> }
  const verify = async (packageRoot: string, path: string, expectedHash: string, expectedBytes?: number): Promise<BrowserAsset> => {
    const [realRoot, realFile, info] = await Promise.all([realpath(packageRoot), realpath(path), stat(path)])
    const rel = relative(realRoot, realFile)
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || !info.isFile() || info.size < 1
      || (expectedBytes !== undefined && info.size !== expectedBytes) || !/^[a-f0-9]{64}$/.test(expectedHash ?? ''))
      throw new Error('Invalid installed browser resource')
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(realFile)) hash.update(bytes)
    if (hash.digest('hex') !== expectedHash) throw new Error('Installed browser resource checksum differs')
    return Object.freeze({ path: realFile, bytes: info.size, sha256: expectedHash })
  }
  const files = { worker: await verify(root, join(root, worker.path), worker.sha256, worker.bytes) } as Record<keyof BrowserAssets['files'], BrowserAsset>
  for (const key of ['loader', 'wasm', 'data', 'metadata'] as const) {
    const path = engine[key]
    const expectedHash = prebuild.files?.[relative(engine.root, path).split(sep).join('/')]
    if (!expectedHash) throw new Error(`Unreceipted WASM resource: ${key}`)
    files[key] = await verify(engine.root, path, expectedHash)
  }
  return Object.freeze({ schemaVersion: 1, programDirectory: engine.programDirectory, files: Object.freeze(files) })
}
