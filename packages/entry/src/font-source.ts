/** Lazy Node font service, independent of native or WASM engine installation. */
import { Worker } from 'node:worker_threads'
import { resolveOptions } from './options.ts'
import type { FontAssetId, FontCommand, FontMatchRequest, FontReply, FontResolution, FontSource, FontSourceOptions } from './font-source-types.ts'

export type { FontAsset, FontAssetId, FontMatchRequest, FontResolution, FontSource, FontSourceOptions } from './font-source-types.ts'

/**
 * Create a font catalog without loading a LibreOffice engine or reading fonts yet.
 * @param options - Font directories, fallback groups, and discovery limits.
 * @returns a source whose first operation starts its private Worker. Cancellation
 * discards a result after dispatched work settles; dispose terminates all work.
 */
export function createFontSource(options: FontSourceOptions = {}): FontSource {
  const { fontDirectories, fontFallbacks, maxCachedSubsetBytes = 128 * 1024 * 1024, ...limits } = options
  if (!Number.isSafeInteger(maxCachedSubsetBytes) || maxCachedSubsetBytes < 1) throw new TypeError('maxCachedSubsetBytes must be a positive integer.')
  const resolved = resolveOptions({
    ...limits,
    ...(fontDirectories === undefined ? {} : { fontDirectories: [...fontDirectories] }),
    ...(fontFallbacks === undefined ? {} : { fontFallbacks: fontFallbacks.map(group => [...group]) }),
  })
  let worker: Worker | undefined
  let nextId = 0
  let failure: Error | undefined
  let closing: Promise<void> | undefined
  const pending = new Map<number, { resolve: (reply: FontReply) => void; reject: (reason: Error) => void }>()

  const fail = (error: Error): void => {
    failure ??= error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  function start(): Worker {
    if (failure !== undefined) throw failure
    if (worker !== undefined) return worker
    worker = new Worker(new URL('./font-worker.js', import.meta.url), {
      execArgv: [], workerData: {
        directories: resolved.fontDirectories, fallbackFamilies: resolved.fontFallbacks,
        maxFiles: resolved.maxFontFiles, maxFileBytes: resolved.maxFontFileBytes, maxCachedSubsetBytes,
      },
    })
    worker.on('message', (value: unknown) => {
      if (typeof value !== 'object' || value === null || !('id' in value) || typeof value.id !== 'number'
        || !('kind' in value) || !['resolved', 'bytes', 'failed'].includes(String(value.kind))) {
        fail(new Error('The font Worker returned an invalid reply.'))
        void worker?.terminate()
        return
      }
      const reply = value as FontReply
      const waiter = pending.get(reply.id)
      if (waiter === undefined) return
      pending.delete(reply.id)
      if (reply.kind === 'failed') waiter.reject(new Error(reply.message))
      else waiter.resolve(reply)
    })
    worker.on('error', fail)
    worker.on('exit', (code) => {
      if (closing === undefined) fail(new Error(`The font Worker exited with code ${code}.`))
    })
    return worker
  }
  async function call(command: FontCommand, signal?: AbortSignal): Promise<FontReply> {
    signal?.throwIfAborted()
    const owner = start()
    const reply = await new Promise<FontReply>((resolve, reject) => {
      pending.set(command.id, { resolve, reject })
      try { owner.postMessage(command) } catch (error) {
        pending.delete(command.id)
        reject(error)
      }
    })
    signal?.throwIfAborted()
    return reply
  }
  return {
    fontFallbacks: resolved.fontFallbacks,
    async resolve(request: FontMatchRequest, signal?: AbortSignal): Promise<FontResolution> {
      const reply = await call({ id: ++nextId, kind: 'resolve', request }, signal)
      if (reply.kind !== 'resolved') throw new Error('The font Worker returned the wrong operation.')
      return reply.value
    },
    async read(asset: FontAssetId, signal?: AbortSignal): Promise<Uint8Array> {
      const reply = await call({ id: ++nextId, kind: 'read', asset }, signal)
      if (reply.kind !== 'bytes' || !(reply.value instanceof Uint8Array)) throw new Error('The font Worker returned invalid bytes.')
      return reply.value
    },
    dispose(): Promise<void> {
      if (closing !== undefined) return closing
      fail(new Error('The font source is disposed.'))
      closing = worker === undefined ? Promise.resolve() : worker.terminate().then(() => {})
      return closing
    },
  }
}
