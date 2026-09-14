/** Resolve Core from the submodule while keeping the WASM toolchain recipe separate. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCoreSource } from '../core-source.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export function readWasmSource(repo = root) {
  const recipe = JSON.parse(readFileSync(join(repo, 'engine/wasm-source/source.json'), 'utf8'));
  const { repository, revision } = readCoreSource(repo);
  return { ...recipe, libreoffice: { ...recipe.libreoffice, repository, commit: revision } };
}
