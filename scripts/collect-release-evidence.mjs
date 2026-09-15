/** Join host-produced receipts only when every platform tested the same candidate bytes. */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { kitManifest, readJson, tarballName } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';

const directory = resolve(process.argv[2]);
const release = readJson(join(directory, 'release.json'));
const releaseManifestSha256 = sha256(join(directory, 'release.json'));
const adapterSha256 = sha256(join(directory, tarballName(kitManifest())));
const sourceCommit = process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(sourceCommit ?? ''), 'GITHUB_SHA must identify the candidate source commit');
const platforms = release.platforms.map((platform) => {
  const receipt = readJson(join(directory, 'evidence', `${platform}.json`));
  assert(receipt.platform === platform && receipt.sourceCommit === sourceCommit && receipt.releaseManifestSha256 === releaseManifestSha256
    && receipt.passed === true && receipt.wasmInstalled === (platform === 'wasm') && receipt.nativeInstalled === (platform !== 'wasm'), `Invalid host receipt: ${platform}`);
  assert(receipt[platform === 'wasm' ? 'wasm' : 'native']?.adapter?.sha256 === adapterSha256,
    `Host receipt used different adapter bytes: ${platform}`);
  return receipt;
});
writeFileSync(join(directory, 'verification.json'), `${JSON.stringify({ sourceCommit, releaseManifestSha256, platforms }, null, 2)}\n`);
