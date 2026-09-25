/** Restore native artifacts only from successful builds or matching-host import verification. */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { run } from './pack-utils.mjs';
import { assert } from './verify-artifacts.mjs';
import { isMain, releaseTargets, sourceRepository } from './platform-matrix.mjs';

/** Parse platform-to-run IDs without permitting shell syntax, unknown targets or unqualified workflows. */
export function nativeImports(value, readRun) {
  const mapping = JSON.parse(value);
  assert(mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping), 'Native runs must be a platform-to-run-ID object');
  const targets = releaseTargets([]).filter(platform => platform !== 'wasm');
  return Object.entries(mapping).map(([platform, id]) => {
    assert(targets.includes(platform) && typeof id === 'string' && /^[1-9][0-9]*$/.test(id), 'Invalid native platform or run ID');
    const record = readRun(id);
    assert(record.repository?.full_name === sourceRepository && record.status === 'completed' && record.conclusion === 'success'
      && ['.github/workflows/libreoffice-kit-build-native.yml', '.github/workflows/libreoffice-kit-import-native.yml'].includes(record.path),
    'Native payload requires a successful build or verified import in this repository');
    return { platform, id };
  });
}

if (isMain(import.meta.url)) {
  const imports = nativeImports(process.env.NATIVE_RUNS || '{}', id => JSON.parse(run('gh', ['api', `repos/${sourceRepository}/actions/runs/${id}`])));
  const destination = resolve('.release/native-payload');
  mkdirSync(destination, { recursive: true });
  for (const { platform, id } of imports) {
    run('gh', ['run', 'download', id, '--repo', sourceRepository, '--name', `core-payload-${platform}`, '--dir', destination], { timeout: 900_000 });
    run('tar', ['-xzf', resolve(destination, `core-payload-${platform}.tar.gz`)], { timeout: 900_000 });
  }
  console.log(JSON.stringify(imports));
}
