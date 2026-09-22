import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyNativeSizeGrowth } from '../scripts/verify-native-size-growth.mjs'

const platforms = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']
const release = bytes => ({ packages: platforms.map(platform => ({ platform, install: { bytes } })) })

test('accepts native install archives at the ten-percent growth boundary', () => {
  const result = verifyNativeSizeGrowth(release(100), release(110))
  assert.deepEqual(result.map(entry => entry.ratio), [1.1, 1.1, 1.1, 1.1])
})

test('rejects oversized and incomplete native candidates', () => {
  assert.throws(() => verifyNativeSizeGrowth(release(100), release(111)), /grew to 111.00%/)
  assert.throws(() => verifyNativeSizeGrowth(release(100), { packages: [] }), /Missing native install size/)
})
