/** Exact filesystem identifiers with JSON-compatible font metadata. */
import type { BigIntStats } from 'node:fs'

/** Preserve 64-bit device and inode values without JavaScript integer rounding. */
export function fontFileIdentity(status: BigIntStats) {
  return { dev: status.dev.toString(), ino: status.ino.toString(), size: Number(status.size),
    mtimeMs: Number(status.mtimeNs) / 1e6, ctimeMs: Number(status.ctimeNs) / 1e6 }
}

/** Compare a source descriptor's exact identity with its indexed font metadata. */
export function matchesFontFile(status: BigIntStats, expected: ReturnType<typeof fontFileIdentity>): boolean {
  const current = fontFileIdentity(status)
  return (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const).every(key => current[key] === expected[key])
}
