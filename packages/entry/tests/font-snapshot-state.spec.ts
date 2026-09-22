/** Explicit Worker barriers exercise independent waiters, failed scans, and joined cancellation. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FontSnapshotState, runFontSnapshot } from '../src/font-snapshot-state.ts'
import type { FontSnapshot } from '../src/font-snapshot.ts'
import type { FontSnapshotRequest } from '../src/font-snapshot-worker.ts'
import { resolveOptions } from '../src/options.ts'

const control = vi.hoisted(() => ({ workers: [] as FakeWorker[] }))
class FakeWorker extends EventEmitter {
  stdout = { resume() {} }
  stderr = { resume() {} }
  readonly stopped = Promise.withResolvers<void>()
  readonly exited = Promise.withResolvers<number>()
  readonly data: FontSnapshotRequest
  terminate = vi.fn(async () => { this.stopped.resolve(); return this.exited.promise })
  constructor(_url: URL, options: { workerData: FontSnapshotRequest }) {
    super(); this.data = options.workerData; control.workers.push(this)
  }
  succeed(snapshot: FontSnapshot = empty): void { this.emit('message', { ok: true, snapshot }); this.exited.resolve(0) }
}
vi.mock('node:worker_threads', () => ({ Worker: class { constructor(...args: ConstructorParameters<typeof FakeWorker>) { return new FakeWorker(...args) } } }))
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, rm: vi.fn(fs.rm) }
})
const empty: FontSnapshot = { generation: 'empty', faces: [], records: [] }
const options = resolveOptions({ fontDirectories: [], fontMetadataCacheDirectory: false })
const signal = () => new AbortController().signal
const last = () => control.workers.at(-1)!
afterEach(() => { for (const worker of control.workers.splice(0)) worker.exited.resolve(0); vi.resetAllMocks() })

it('merges four simultaneous scans and joins the Worker before returning metadata', async () => {
  const state = new FontSnapshotState()
  const pending = Array.from({ length: 4 }, () => state.acquire(options, signal()))
  expect(control.workers).toHaveLength(1)
  last().succeed()
  expect(await Promise.all(pending)).toEqual(Array(4).fill(empty))
  expect(last().terminate).toHaveBeenCalledOnce()
  const later = state.acquire(options, signal())
  expect(control.workers).toHaveLength(2)
  last().succeed(); await later
})

it('cancels one waiter without interrupting the surviving scan', async () => {
  const state = new FontSnapshotState(), controller = new AbortController()
  const cancelled = state.acquire(options, controller.signal), survivor = state.acquire(options, signal())
  const rejected = expect(cancelled).rejects.toThrow('only me')
  controller.abort(new Error('only me')); await rejected
  expect(last().terminate).not.toHaveBeenCalled()
  last().succeed(); expect(await survivor).toEqual(empty)
})

it('joins termination after all waiters cancel and allows a later scan only after cleanup', async () => {
  const state = new FontSnapshotState(), first = new AbortController(), second = new AbortController()
  const a = state.acquire(options, first.signal), b = state.acquire(options, second.signal)
  const checkA = expect(a).rejects.toThrow('first'), checkB = expect(b).rejects.toThrow('second')
  const old = last()
  first.abort(new Error('first')); second.abort(new Error('second'))
  await old.stopped.promise; await checkA
  const next = state.acquire(options, signal())
  expect(control.workers).toHaveLength(1)
  old.exited.resolve(0); await checkB
  // The new scan's creation occurs after the old scan's joined promise settles.
  await vi.waitFor(() => expect(control.workers).toHaveLength(2))
  last().succeed(); await next
})

it('does not create a Worker for an already cancelled operation', async () => {
  const stopped = AbortSignal.abort(new Error('stopped'))
  await expect(new FontSnapshotState().acquire(options, stopped)).rejects.toThrow('stopped')
  await expect(runFontSnapshot(options, [], stopped)).rejects.toThrow('stopped')
  expect(control.workers).toEqual([])
})

it.each(['error', 'exit', 'message'] as const)('clears a failed %s scan and retries from the font source', async kind => {
  const state = new FontSnapshotState(), pending = state.acquire(options, signal())
  const rejected = expect(pending).rejects.toThrow(kind === 'exit' ? 'exited before returning' : 'scan failed')
  if (kind === 'error') last().emit('error', new Error('scan failed'))
  else if (kind === 'exit') last().emit('exit', 17)
  else last().emit('message', { ok: false, error: 'scan failed' })
  last().exited.resolve(0); await rejected
  const retry = state.acquire(options, signal()); last().succeed(); await retry
  expect(control.workers).toHaveLength(2)
})

it('retains only records within the byte limit and releases them on clear', async () => {
  const state = new FontSnapshotState()
  const records = [{ path: '/font.ttf', dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, faces: [] }]
  let pending = state.acquire(options, signal()); last().succeed({ ...empty, records }); await pending
  pending = state.acquire(options, signal()); expect(last().data.previous).toEqual(records); last().succeed({ ...empty, records }); await pending
  state.clear()
  pending = state.acquire({ ...options, maxFontMetadataCacheBytes: 1 }, signal())
  expect(last().data.previous).toEqual([]); last().succeed({ ...empty, records }); await pending
  pending = state.acquire(options, signal()); expect(last().data.previous).toEqual([]); last().succeed(); await pending
})

it('removes its interrupted temporary file after Worker exit and tolerates an inaccessible optional cache', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kit-snapshot-state-'))
  try {
    const controller = new AbortController()
    const pending = runFontSnapshot({ ...options, fontMetadataCacheDirectory: directory }, [], controller.signal)
    const rejected = expect(pending).rejects.toThrow('stop')
    const worker = last(), path = worker.data.temporaryPath!
    await writeFile(path, 'interrupted', { flag: 'wx' })
    controller.abort(new Error('stop')); await worker.stopped.promise
    expect((await stat(path)).isFile()).toBe(true)
    worker.exited.resolve(0); await rejected
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    const next = runFontSnapshot({ ...options, fontMetadataCacheDirectory: directory }, [], signal())
    vi.mocked(rm).mockRejectedValueOnce(new Error('cache unavailable'))
    last().succeed(); expect(await next).toEqual(empty)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('honors cancellation while waiting for a previous scan to terminate', async () => {
  const state = new FontSnapshotState(), first = new AbortController(), next = new AbortController()
  const pending = state.acquire(options, first.signal), check = expect(pending).rejects.toThrow('stop')
  first.abort(new Error('stop')); await last().stopped.promise
  const following = state.acquire(options, next.signal), rejected = expect(following).rejects.toThrow('next')
  next.abort(new Error('next')); last().exited.resolve(0)
  await Promise.all([check, rejected]); expect(control.workers).toHaveLength(1)
})
