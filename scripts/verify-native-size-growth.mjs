/** Enforce native install archive growth against a qualified release baseline. */
import { readFileSync } from 'node:fs'
import { isMain } from './platform-matrix.mjs'

function read(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Compare matching native package installation bytes.
 * @param {object} baseline - qualified baseline release manifest.
 * @param {object} candidate - candidate release manifest.
 * @param {number} ratio - inclusive maximum candidate/baseline ratio.
 * @param {readonly string[]} platforms - native platforms that must be present.
 * @returns {{platform:string, baselineBytes:number, candidateBytes:number, ratio:number}[]}
 */
export function verifyNativeSizeGrowth(baseline, candidate, ratio = 1.1,
  platforms = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64']) {
  if (!Number.isFinite(ratio) || ratio < 1) throw new Error('Native size ratio must be at least one')
  const byPlatform = release => new Map((release.packages ?? []).map(record => [record.platform, record]))
  const oldPackages = byPlatform(baseline), newPackages = byPlatform(candidate)
  return platforms.map(platform => {
    const oldRecord = oldPackages.get(platform), newRecord = newPackages.get(platform)
    const baselineBytes = oldRecord?.install?.bytes, candidateBytes = newRecord?.install?.bytes
    if (!Number.isSafeInteger(baselineBytes) || baselineBytes < 1
      || !Number.isSafeInteger(candidateBytes) || candidateBytes < 1)
      throw new Error(`Missing native install size for ${platform}`)
    const actual = candidateBytes / baselineBytes
    if (actual > ratio) throw new Error(`${platform} install archive grew to ${(actual * 100).toFixed(2)}% of 0.0.1; limit is ${(ratio * 100).toFixed(2)}%`)
    return { platform, baselineBytes, candidateBytes, ratio: actual }
  })
}

if (isMain(import.meta.url)) {
  const [baselinePath, candidatePath, ratioText] = process.argv.slice(2)
  if (!baselinePath || !candidatePath) throw new Error('Usage: verify-native-size-growth <baseline-release.json> <candidate-release.json> [ratio]')
  console.log(JSON.stringify(verifyNativeSizeGrowth(read(baselinePath), read(candidatePath), ratioText === undefined ? 1.1 : Number(ratioText)), null, 2))
}
