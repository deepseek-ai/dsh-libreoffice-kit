/** Serialized font matching and portable HarfBuzz subsetting on a private Node Worker. */
import { parentPort, workerData } from 'node:worker_threads'
import { FontSubsetSource } from './font-subsets.ts'
import type { FontSubsetOptions } from './font-subsets.ts'
import type { FontCommand, FontReply } from './font-source-types.ts'

if (parentPort === null) throw new Error('The font service requires a Worker parent.')
const port = parentPort
// The source validates its resolved options before structured cloning to this Worker.
const source = new FontSubsetSource(workerData as FontSubsetOptions)
let queue = Promise.resolve()

port.on('message', (command: FontCommand) => {
  if (!Number.isSafeInteger(command?.id) || !['prepare', 'resolve', 'read'].includes(command.kind)) {
    throw new Error('The font Worker received an invalid operation.')
  }
  queue = queue.then(async () => {
    try {
      if (command.kind === 'prepare') {
        source.prepare()
        port.postMessage({ id: command.id, kind: 'prepared' } satisfies FontReply)
      } else if (command.kind === 'resolve') {
        const value = await source.resolve(command.request)
        port.postMessage({ id: command.id, kind: 'resolved', value } satisfies FontReply)
      } else {
        const value = await source.read(command.asset)
        port.postMessage({ id: command.id, kind: 'bytes', value } satisfies FontReply, [value.buffer])
      }
    } catch (error) {
      port.postMessage({ id: command.id, kind: 'failed', message: error instanceof Error ? error.message : String(error) } satisfies FontReply)
    }
  })
})
