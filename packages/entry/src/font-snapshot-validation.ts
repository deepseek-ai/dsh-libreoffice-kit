/** Verify the operation's source versions before publishing its output. */
import { lstat } from 'node:fs/promises'
import { ConversionError } from './errors.ts'
import type { FontSnapshot } from './font-snapshot.ts'

/** Reject changed, removed, or replaced sources without exposing local font paths. */
export async function validateFontSnapshot(snapshot: FontSnapshot): Promise<void> {
  await Promise.all(snapshot.records.map(async record => {
    try {
      const current = await lstat(record.path)
      if (current.isFile() && (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)
        .every(key => current[key] === record[key])) return
    } catch {
      // A source that cannot be verified cannot authorize publishing this operation's output.
    }
    throw new ConversionError('failed', 'A system font changed during conversion; retry the operation.')
  }))
}
