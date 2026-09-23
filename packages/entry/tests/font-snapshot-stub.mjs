/**
 * A scripted font scan for tests whose fixture font is not a parseable font file.
 * It answers the entry's Worker protocol with one face from the first configured root.
 */
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { parentPort, workerData } from 'node:worker_threads'

const directory = workerData.options.fontDirectories[0]
const faces = []
if (directory !== undefined) {
  const path = join(directory, 'fixture.ttf')
  try {
    const { size, mtimeMs, ctimeMs, dev, ino } = statSync(path)
    faces.push({ path, size, mtimeMs, ctimeMs, dev, ino, faceIndex: 0, family: 'Fixture Face',
      aliases: ['fixtureface'], style: 'Regular', weight: 400, width: 5, italic: false, fixed: false,
      postscriptName: 'FixtureFace', coverage: [[0, 0x10ffff]] })
  }
  catch {
    // Engine-selection and missing-font cases configure no fixture root.
  }
}
parentPort.postMessage({ ok: true, snapshot: { faces, records: [], generation: faces.length === 0 ? 'empty' : 'fixture' } })
