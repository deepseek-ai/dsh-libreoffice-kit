import { afterEach, expect, it, vi } from 'vitest'
import type { EventEmitter } from 'node:events'
import type { FontCommand } from '../src/font-source-types.ts'
import { createFontSource } from '../src/font-source.ts'

const state = vi.hoisted(() => ({ workers: [] as (EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn> })[] }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn()
    terminate = vi.fn(async () => 0)
    constructor(entry: URL, options: { execArgv: unknown[]; workerData: unknown }) {
      super()
      expect(entry.pathname).toMatch(/font-worker\.js$/)
      expect(options.execArgv).toEqual([])
      state.workers.push(this)
    }
  } }
})
afterEach(() => { state.workers.splice(0) })
const request = { family: 'Face', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [65] }
function worker() { return state.workers.at(-1)! }
function command(): FontCommand { return worker().postMessage.mock.lastCall![0] as FontCommand }

it('validates cache limits, copies options, and starts no Worker until needed', async () => {
  for (const maxCachedSubsetBytes of [0, -1, 0.1, Number.NaN]) expect(() => createFontSource({ maxCachedSubsetBytes })).toThrow(/maxCachedSubsetBytes/)
  const groups = [['A', 'B']]
  const source = createFontSource({ fontDirectories: [], fontFallbacks: groups })
  groups[0]!.push('C')
  expect(source.fontFallbacks).toEqual([['A', 'B']])
  expect(state.workers).toHaveLength(0)
  const disposed = source.dispose()
  expect(source.dispose()).toBe(disposed)
  await disposed
  await expect(source.resolve(request)).rejects.toThrow(/disposed/)
})

it('pairs queued replies by identity and ignores replies for completed operations', async () => {
  const source = createFontSource()
  try {
    const first = source.resolve(request)
    const second = source.resolve(request)
    const id = command().id
    worker().emit('message', { id, kind: 'resolved', value: { fonts: [] } })
    expect(await second).toEqual({ fonts: [] })
    worker().emit('message', { id, kind: 'resolved', value: { fonts: [] } })
    worker().emit('message', { id: id - 1, kind: 'failed', message: 'matching failed' })
    await expect(first).rejects.toThrow('matching failed')
    const read = source.read('id' as never)
    worker().emit('message', { id: command().id, kind: 'bytes', value: Uint8Array.of(1) })
    expect(await read).toEqual(Uint8Array.of(1))
    expect(state.workers).toHaveLength(1)
  } finally { await source.dispose() }
})

it('cancellation before dispatch starts no Worker and cancellation after dispatch discards its reply', async () => {
  const source = createFontSource()
  try {
    await expect(source.resolve(request, AbortSignal.abort(new Error('before')))).rejects.toThrow('before')
    expect(state.workers).toHaveLength(0)
    const abort = new AbortController()
    const pending = source.resolve(request, abort.signal)
    abort.abort(new Error('after'))
    worker().emit('message', { id: command().id, kind: 'resolved', value: { fonts: [] } })
    await expect(pending).rejects.toThrow('after')
  } finally { await source.dispose() }
})

it.each([null, {}, { id: 'wrong', kind: 'bytes' }, { id: 1, kind: 'unknown' }])('invalid Worker messages poison the source and terminate its Worker: %j', async value => {
  const source = createFontSource()
  const pending = source.resolve(request)
  worker().emit('message', value)
  await expect(pending).rejects.toThrow(/invalid reply/)
  await expect(source.resolve(request)).rejects.toThrow(/invalid reply/)
  expect(worker().terminate).toHaveBeenCalledOnce()
  await source.dispose()
})

it('reply payloads must match their requested operations', async () => {
  const source = createFontSource()
  try {
    const resolve = source.resolve(request)
    worker().emit('message', { id: command().id, kind: 'bytes', value: Uint8Array.of(1) })
    await expect(resolve).rejects.toThrow(/wrong operation/)
    for (const reply of [{ kind: 'resolved', value: { fonts: [] } }, { kind: 'bytes', value: 'bad' }]) {
      const read = source.read('id' as never)
      worker().emit('message', { id: command().id, ...reply })
      await expect(read).rejects.toThrow(/invalid bytes/)
    }
  } finally { await source.dispose() }
})

it('postMessage errors release the waiter and do not stop later requests', async () => {
  const source = createFontSource()
  try {
    const warmup = source.resolve(request)
    worker().emit('message', { id: command().id, kind: 'resolved', value: { fonts: [] } })
    await warmup
    worker().postMessage.mockImplementationOnce(() => { throw new Error('clone failed') })
    await expect(source.resolve(request)).rejects.toThrow('clone failed')
    const next = source.resolve(request)
    worker().emit('message', { id: command().id, kind: 'resolved', value: { fonts: [] } })
    await next
  } finally { await source.dispose() }
})

it.each(['error', 'exit'])('unexpected Worker %s rejects pending requests', async event => {
  const source = createFontSource()
  const pending = source.resolve(request)
  worker().emit(event, event === 'error' ? new Error('crashed') : 9)
  await expect(pending).rejects.toThrow(event === 'error' ? 'crashed' : 'code 9')
  await source.dispose()
})

it('dispose joins Worker termination, rejects pending calls and tolerates the expected exit', async () => {
  const source = createFontSource()
  const pending = source.resolve(request)
  let finish!: () => void
  worker().terminate.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const disposed = source.dispose()
  expect(source.dispose()).toBe(disposed)
  worker().emit('exit', 1)
  await expect(pending).rejects.toThrow(/disposed/)
  finish()
  await disposed
})
