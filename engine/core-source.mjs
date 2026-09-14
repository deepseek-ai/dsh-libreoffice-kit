/** The submodule gitlink and .gitmodules are the workspace's only Core pin. */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const coreSubmodule = 'engine/core';

export function readCoreSource(repo = root) {
  let source;
  if (existsSync(join(repo, '.git'))) {
    const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
    const path = git(['config', '--file', '.gitmodules', '--get', 'submodule.libreoffice.path']);
    if (path !== coreSubmodule) throw new Error(`LibreOffice submodule must be at ${coreSubmodule}`);
    const entry = git(['ls-files', '--stage', '--', coreSubmodule]);
    const match = entry.match(/^160000 ([a-f0-9]{40}) 0\tengine\/core$/);
    if (!match) throw new Error('LibreOffice requires a single staged submodule gitlink; resolve conflicts and git add engine/core');
    source = { repository: git(['config', '--file', '.gitmodules', '--get', 'submodule.libreoffice.url']), revision: match[1] };
  } else {
    // Engine tarballs have no Git metadata. Staging exports the resolved pin here.
    source = JSON.parse(readFileSync(join(repo, 'core-source.json'), 'utf8'));
  }
  if (!/^https:\/\//.test(source.repository) || !/^[a-f0-9]{40}$/.test(source.revision))
    throw new Error('Core source requires an HTTPS repository and full commit');
  return Object.freeze({ repository: source.repository, revision: source.revision });
}
