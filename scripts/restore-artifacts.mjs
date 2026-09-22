/** Restore CI archives, preserving executable modes, before any consumer packs its workspace. */
import { join, resolve } from 'node:path';
import { copyFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { artifactPlan, verifyPreparedEngine } from './prepare-artifacts.mjs';
import { root } from './platform-matrix.mjs';
import { assert, regularFile } from './verify-artifacts.mjs';
import { reversionEngine } from './reversion-engine.mjs';
import { run } from './pack-utils.mjs';

const [selection, input = join(root, '.release/prepared'), reuseVersion = ''] = process.argv.slice(2);
for (const platform of artifactPlan(selection)) {
  const archive = regularFile(resolve(input), `core-payload-${platform}.tar.gz`);
  if (!reuseVersion) run('tar', ['-xzf', archive, '-C', root], { timeout: 900_000 });
  else {
    const work = mkdtempSync(join(tmpdir(), 'kit-reversion-'));
    try {
      run('tar', ['-xzf', archive, '-C', work], { timeout: 900_000 });
      const source = join(work, 'packages', platform);
      const destination = join(root, 'packages', platform);
      reversionEngine(platform, source, reuseVersion);
      for (const part of ['assets', 'bin', 'program', 'sources', 'licenses']) {
        assert(!existsSync(join(destination, part)), `Reuse requires an unstaged ${platform} package`);
        if (existsSync(join(source, part))) cpSync(join(source, part), join(destination, part), { recursive: true });
      }
      copyFileSync(join(source, 'prebuilds.json'), join(destination, 'prebuilds.json'));
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(verifyPreparedEngine(platform)));
}
