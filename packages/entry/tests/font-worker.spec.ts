import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const source = { resolve: vi.fn(), read: vi.fn() }
const port = new EventEmitter() as EventEmitter & { postMessage: ReturnType<typeof vi.fn> }
port.postMessage = vi.fn()
afterEach(() => { vi.resetModules(); vi.doUnmock('node:worker_threads'); vi.doUnmock('../src/font-subsets.ts'); port.removeAllListeners(); vi.resetAllMocks() })
async function start(parent: typeof port | null = port) {
  vi.doMock('node:worker_threads', () => ({ parentPort: parent, workerData: {} }))
  vi.doMock('../src/font-subsets.ts', () => ({ FontSubsetSource: class { resolve = source.resolve; read = source.read } }))
  await import('../src/font-worker.ts')
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve))

it('font Workers require a parent and reject malformed operation envelopes', async () => {
  await expect(start(null)).rejects.toThrow(/parent/)
  vi.resetModules()
  await start()
  for (const command of [null, { id: -0.5, kind: 'read' }, { id: 1, kind: 'other' }]) expect(() => port.emit('message', command)).toThrow(/invalid operation/)
})

it('font Worker commands serialize initialization, matching and transferable reads', async () => {
  await start()
  let finish!: (value: { fonts: never[] }) => void
  source.resolve.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  source.read.mockResolvedValueOnce(Uint8Array.of(1))
  port.emit('message', { id: 1, kind: 'resolve', request: {} })
  port.emit('message', { id: 2, kind: 'read', asset: 'id' })
  await settle()
  expect(source.read).not.toHaveBeenCalled()
  finish({ fonts: [] })
  await settle()
  expect(port.postMessage.mock.calls[0]).toEqual([{ id: 1, kind: 'resolved', value: { fonts: [] } }])
  const [reply, transfer] = port.postMessage.mock.calls[1]!
  expect(reply).toEqual({ id: 2, kind: 'bytes', value: Uint8Array.of(1) })
  expect(transfer).toEqual([reply.value.buffer])
})

it('failed operations report errors without poisoning the following request', async () => {
  await start()
  source.resolve.mockRejectedValueOnce(new Error('font failed')).mockRejectedValueOnce('plain failure').mockResolvedValueOnce({ fonts: [] })
  for (const id of [1, 2, 3]) port.emit('message', { id, kind: 'resolve', request: {} })
  await settle()
  expect(port.postMessage.mock.calls.map(call => call[0])).toEqual([
    { id: 1, kind: 'failed', message: 'font failed' }, { id: 2, kind: 'failed', message: 'plain failure' }, { id: 3, kind: 'resolved', value: { fonts: [] } },
  ])
})
