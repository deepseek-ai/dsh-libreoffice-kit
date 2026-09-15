/** A receipt is emitted only after the host's installed engine converts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { verifyPackedInstall } from './verify-packed-install.mjs';
import { hostTarget } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';

const directory = resolve(process.argv[2]);
const platform = process.argv.includes('--wasm-only') ? 'wasm' : hostTarget();
assert(platform, 'This host has no declared native target');
const sourceCommit = process.env.GITHUB_SHA;
assert(/^[a-f0-9]{40}$/.test(sourceCommit ?? ''), 'GITHUB_SHA must identify the candidate source commit');
const wasm = platform === 'wasm' ? verifyPackedInstall(directory, { wasmOnly: true }) : undefined;
const native = platform === 'wasm' ? undefined : verifyPackedInstall(directory, { nativeOnly: true, wasmOnly: false });
const result = { platform, sourceCommit, releaseManifestSha256: sha256(join(directory, 'release.json')),
  nativeInstalled: Boolean(native), wasmInstalled: Boolean(wasm), passed: true, native, wasm };
mkdirSync(join(directory, 'evidence'), { recursive: true });
writeFileSync(join(directory, 'evidence', `${platform}.json`), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
