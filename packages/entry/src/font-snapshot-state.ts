/** Shared in-flight metadata work with independent cancellation and joined Worker cleanup. */
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FontSnapshot } from './font-snapshot.ts'
import type { FontFileMetadata } from './fonts.ts'
import type { FontSnapshotRequest } from './font-snapshot-worker.ts'
import type { ResolvedOptions } from './options.ts'

/** Run one scan outside the event loop and join it before returning or cleaning its temporary file. */
export async function runFontSnapshot(options: ResolvedOptions, previous: readonly FontFileMetadata[], signal: AbortSignal): Promise<FontSnapshot> {
  signal.throwIfAborted()
  const temporaryPath = options.fontMetadataCacheDirectory === false ? undefined
    : join(options.fontMetadataCacheDirectory, `.font-metadata-${randomUUID()}.tmp`)
  const data: FontSnapshotRequest = { options, previous, ...(temporaryPath === undefined ? {} : { temporaryPath }) }
  const worker = new Worker(new URL('./font-snapshot-worker.js', import.meta.url), {
    workerData: data, execArgv: [], name: 'libreoffice-font-metadata', stdout: true, stderr: true,
  })
  worker.stdout.resume()
  worker.stderr.resume()
  const result = Promise.withResolvers<FontSnapshot>()
  const abort = (): void => result.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  worker.once('error', result.reject)
  worker.once('exit', code => result.reject(new Error(`Font metadata worker exited before returning a snapshot (${code}).`)))
  worker.once('message', (message: { ok: true; snapshot: FontSnapshot } | { ok: false; error: string }) => {
    if (message.ok) result.resolve(message.snapshot)
    else result.reject(new Error(message.error))
  })
  try { return await result.promise } finally {
    signal.removeEventListener('abort', abort)
    await worker.terminate()
    if (temporaryPath !== undefined) {
      try { await rm(temporaryPath, { force: true }) } catch {
        // An inaccessible optional cache must not make a successful source scan fail.
      }
    }
  }
}

interface Scan {
  readonly controller: AbortController
  readonly promise: Promise<FontSnapshot>
  waiters: number
}

/** Each acquisition refreshes inventory; overlapping acquisitions share only the active scan. */
export class FontSnapshotState {
  private previous: readonly FontFileMetadata[] = []
  private scan: Scan | undefined

  /** Revalidate files for an operation without coupling its cancellation to other waiters. */
  async acquire(options: ResolvedOptions, signal: AbortSignal): Promise<FontSnapshot> {
    signal.throwIfAborted()
    // A cancelled scan must finish cleanup before a later operation can replace it.
    while (this.scan?.controller.signal.aborted) {
      await this.scan.promise.catch(() => {})
      signal.throwIfAborted()
    }
    if (this.scan === undefined) {
      const controller = new AbortController()
      const promise = runFontSnapshot(options, this.previous, controller.signal).then(snapshot => {
        this.previous = Buffer.byteLength(JSON.stringify(snapshot.records)) <= options.maxFontMetadataCacheBytes ? snapshot.records : []
        return snapshot
      }).finally(() => { this.scan = undefined })
      this.scan = { controller, promise, waiters: 0 }
    }
    const scan = this.scan
    scan.waiters++
    const cancelled = Promise.withResolvers<never>()
    const abort = (): void => cancelled.reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try { return await Promise.race([scan.promise, cancelled.promise]) } finally {
      signal.removeEventListener('abort', abort)
      scan.waiters--
      if (scan.waiters === 0 && this.scan === scan) {
        scan.controller.abort(new Error('All font scan waiters stopped.'))
        await scan.promise.catch(() => {})
      }
    }
  }

  /** Release completed metadata after the owning factory has joined its operations. */
  clear(): void { this.previous = [] }
}
