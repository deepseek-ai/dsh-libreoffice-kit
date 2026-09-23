/** Short-lived, cancellable metadata scan; no document or font bytes survive Worker exit. */
import { parentPort, workerData } from 'node:worker_threads'
import { scanFontSnapshot } from './font-snapshot.ts'
import { writeFontMetadataCache } from './font-metadata-cache.ts'
import { failureCode } from './errors.ts'
import type { FontFileMetadata } from './fonts.ts'
import type { ResolvedOptions } from './options.ts'

/** Private input supplied by the shared scan owner. */
export interface FontSnapshotRequest {
  readonly options: ResolvedOptions
  readonly previous: readonly FontFileMetadata[]
  readonly temporaryPath?: string
}

try {
  const { options, previous, temporaryPath } = workerData as FontSnapshotRequest
  const snapshot = scanFontSnapshot(options, previous)
  if (temporaryPath !== undefined) writeFontMetadataCache(options, snapshot.records, temporaryPath)
  parentPort!.postMessage({ ok: true, snapshot })
} catch (error) {
  parentPort!.postMessage({ ok: false, code: failureCode(error), error: error instanceof Error ? error.message : String(error) })
}
