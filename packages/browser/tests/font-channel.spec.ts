import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { fontFrames, fontViews } from '../src/font-channel.ts'
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES, FontState } from '../src/protocol.ts'
import type { FontIdentity } from '../src/protocol.ts'

async function exchange(mode: 'complete' | 'cancel' | 'limit' | 'expand' | 'full' | 'repeat-full') {
  const channel = new SharedArrayBuffer(FONT_HEADER_BYTES + FONT_CHUNK_BYTES)
  const views = fontViews(channel)
  const font = new Uint8Array(FONT_CHUNK_BYTES * 2 + 79).fill(73)
  let frames: ReturnType<typeof fontFrames>
  const full = mode === 'full' || mode === 'repeat-full'
  const worker = new Worker(new URL('./font-reader-worker.mjs', import.meta.url), { workerData: { channel, full, repeat: mode === 'repeat-full', expand: mode === 'expand', limit: mode === 'limit' ? 100 : font.length * (mode === 'expand' ? 2 : 1), timeoutMs: 10_000 }, execArgv: ['--import', 'tsx/esm'] })
  const messages: Record<string, unknown>[] = []
  const transfers: FontState[][] = []
  let maxChunk = 0
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on('error', reject)
      worker.on('exit', code => { if (code !== 0) reject(new Error(`font worker exited ${code}`)) })
      worker.on('message', (message: Record<string, unknown> & { known?: readonly FontIdentity[] }) => {
        messages.push(message)
        if (message.type === 'done' || message.type === 'failed') { resolve(); return }
        if (message.type !== 'font' && message.type !== 'next') return
        if (message.type === 'font') {
          const repeated = transfers.length > 0
          transfers.push([])
          frames = full
            ? fontFrames({ fonts: [{ id: 'full-file', data: font, family: repeated ? 'Test Serif' : 'Test', alias: repeated ? 'Test Serif' : 'Test', format: 'ttc' }] }, message.known)
            : mode === 'expand' && repeated
              ? fontFrames({ fonts: [{ id: 'arabic', data: font, family: 'Test', alias: 'DSH_arabic' }] }, message.known)
              : fontFrames({ fonts: [{ id: 'same-file', data: font, family: 'Test', alias: 'DSH_test' }, { id: 'same-file', data: font, family: 'Test', alias: 'DSH_test' }], missingFamily: 'Test' }, message.known)
        }
        if (mode === 'cancel') {
          Atomics.store(views.control, 0, FontState.Cancelled)
          Atomics.notify(views.control, 0)
          return
        }
        const frame = frames.next()
        if (frame.done) return
        transfers.at(-1)!.push(frame.value.state)
        maxChunk = Math.max(maxChunk, frame.value.bytes.length)
        views.bytes.set(frame.value.bytes)
        Atomics.store(views.control, 1, frame.value.bytes.length)
        Atomics.store(views.control, 0, frame.value.state)
        Atomics.notify(views.control, 0)
      })
    })
    return { messages, maxChunk, transfers }
  } finally { await worker.terminate() }
}

describe('synchronous font delivery from an asynchronous owner', () => {
  it('streams bounded chunks, installs a shared TTC-like file once, and caches identical requests', async () => {
    const { messages, maxChunk } = await exchange('complete')
    expect(maxChunk).toBe(FONT_CHUNK_BYTES)
    expect(messages.filter(message => message.type === 'font')).toHaveLength(1)
    expect(messages.find(message => message.type === 'font')?.request).not.toHaveProperty('mode')
    expect(messages.find(message => message.type === 'font')?.known).toEqual([])
    expect(messages.find(message => message.type === 'missing')).toMatchObject({ families: ['Test'] })
    expect(messages.at(-1)).toEqual({ type: 'done', paths: [{ path: '/dsh-fonts/0.font', family: 'DSH_test' }, { path: '/dsh-fonts/0.font', family: 'DSH_test' }], cached: [{ path: '/dsh-fonts/0.font', family: 'DSH_test' }, { path: '/dsh-fonts/0.font', family: 'DSH_test' }], installed: [{ path: '/dsh-fonts/0.font', length: FONT_CHUNK_BYTES * 2 + 79, first: 73, last: 73 }] })
  })
  it('keeps explicit PDF full-font requests and mounts original TTC assets for PDFium', async () => {
    const { messages } = await exchange('full')
    expect(messages.find(message => message.type === 'font')).toMatchObject({ request: { mode: 'full' } })
    expect(messages.at(-1)).toMatchObject({ type: 'done', paths: [{ path: '/usr/share/fonts/dsh-pdfium/0.ttc', family: 'Test' }] })
  })
  it('reuses an installed complete font across requests with only metadata and a trailer', async () => {
    const { messages, transfers } = await exchange('repeat-full')
    const requests = messages.filter(message => message.type === 'font')
    expect(requests).toHaveLength(2)
    expect(requests[0]?.known).toEqual([])
    expect(requests[1]?.known).toEqual([{ id: 'full-file', bytes: FONT_CHUNK_BYTES * 2 + 79, format: 'ttc' }])
    expect(transfers).toEqual([[FontState.Header, FontState.Bytes, FontState.Bytes, FontState.Bytes, FontState.Done], [FontState.Header, FontState.Done]])
    expect(messages.at(-1)).toMatchObject({ type: 'done', repeated: [{ path: '/usr/share/fonts/dsh-pdfium/0.ttc', family: 'Test Serif' }],
      installed: [{ path: '/usr/share/fonts/dsh-pdfium/0.ttc', length: FONT_CHUNK_BYTES * 2 + 79 }] })
  })
  it('translates an internal shard alias back to the original family for another script', async () => {
    const { messages } = await exchange('expand')
    const requests = messages.filter(message => message.type === 'font')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ request: { family: 'Test', codePoints: [0x0627] } })
    expect(messages.at(-1)).toMatchObject({ expanded: [{ path: '/dsh-fonts/1.font', family: 'DSH_arabic' }], installed: [{ path: '/dsh-fonts/0.font' }, { path: '/dsh-fonts/1.font' }] })
  })
  it('unblocks an engine waiting for fonts on cancellation', async () => {
    expect((await exchange('cancel')).messages.at(-1)).toMatchObject({ type: 'failed', name: 'AbortError' })
  })
  it('rejects the document font limit before allocating a supplied font', async () => {
    expect((await exchange('limit')).messages.at(-1)).toMatchObject({ type: 'failed', code: 'font-limit' })
  })
})
