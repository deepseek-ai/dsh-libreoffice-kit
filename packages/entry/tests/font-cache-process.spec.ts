/** Independent publishers may overwrite complete snapshots without admitting foreign font sources. */
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readFontMetadataCache } from '../src/font-metadata-cache.ts'
import { scanFontSnapshot } from '../src/font-snapshot.ts'
import { resolveOptions } from '../src/options.ts'

it('publishes complete snapshots from four synchronized processes and removes owned temporary files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kit-cache-process-'))
  const children: ReturnType<typeof fork>[] = []
  const exits: Promise<unknown>[] = []
  try {
    const cache = join(root, 'cache'); await mkdir(cache)
    const inputs = await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const directory = join(root, `fonts-${index}`); await mkdir(directory)
      await writeFile(join(directory, 'font.ttf'), 'damaged-font')
      return resolveOptions({ fontDirectories: [directory], fontMetadataCacheDirectory: cache })
    }))
    await Promise.all(inputs.map(async () => {
      const child = fork(new URL('./font-cache-process.mjs', import.meta.url), { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      children.push(child); exits.push(once(child, 'exit'))
      const [ready] = await once(child, 'message'); expect(ready).toEqual({ ready: true })
    }))
    const replies = children.map(child => once(child, 'message'))
    children.forEach((child, index) => child.send({ options: inputs[index], temporaryPath: join(cache, `.writer-${index}`) }))
    for (const [reply] of await Promise.all(replies)) expect(reply).toEqual({ ok: true, records: 1, faces: 0 })
    for (const exit of await Promise.all(exits)) expect(exit).toEqual([0, null])
    expect(await readdir(cache)).toEqual(['font-metadata.json'])
    expect(readFontMetadataCache(inputs[0]!)).toHaveLength(1)
    for (const options of inputs) {
      const snapshot = scanFontSnapshot(options)
      expect(snapshot.records).toHaveLength(1)
      expect(snapshot.records[0]?.path).toContain('fonts-')
      expect(snapshot.records[0]?.path).toBe(realpathSync(join(options.fontDirectories[0]!, 'font.ttf')))
    }
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill()
    await Promise.allSettled(exits)
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
