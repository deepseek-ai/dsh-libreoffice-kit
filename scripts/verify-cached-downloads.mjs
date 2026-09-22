/** LibreOffice skips checksums for existing tarballs; verify cache hits ourselves. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function downloadChecksums(text) {
  const variables = new Map([...text.matchAll(/^([A-Z0-9_]+)\s*:?=\s*([^\r\n#]+)/gm)]
    .map(([, name, value]) => [name, value.trim()]));
  function expand(value, seen = new Set()) {
    return value.replace(/\$\(([A-Z0-9_]+)\)/g, (_, name) => {
      if (seen.has(name) || !variables.has(name)) throw new Error(`Invalid download variable: ${name}`);
      return expand(variables.get(name), new Set([...seen, name]));
    });
  }
  const checksums = new Map();
  for (const [name, value] of variables) {
    if (!/_(TARBALL|TTF|DLL|PACK|JAR)$/.test(name)) continue;
    const file = expand(value);
    const hash = variables.get(name.replace(/_(TARBALL|TTF|DLL|PACK|JAR)$/, '_SHA256SUM'));
    if (file !== basename(file) || file === '.' || file === '..' || /[\s$\\]/.test(file)
      || !/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error(`Invalid download declaration: ${name}`);
    if (checksums.has(file) && checksums.get(file) !== hash) throw new Error(`Conflicting download checksum: ${file}`);
    checksums.set(file, hash);
  }
  if (!checksums.size) throw new Error('No pinned download checksums found');
  return checksums;
}

export function verifyCachedDownloads(list, directory) {
  let verified = 0;
  const removed = [];
  for (const [file, expected] of downloadChecksums(readFileSync(list, 'utf8'))) {
    const target = join(directory, file);
    // Reject symlinks as well as corrupt archives, without following their targets.
    let stat;
    try { stat = lstatSync(target); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isDirectory()) throw new Error(`Download cache contains a directory in place of ${file}`);
    if (!stat.isFile() || createHash('sha256').update(readFileSync(target)).digest('hex') !== expected) {
      unlinkSync(target);
      removed.push(file);
    } else verified++;
  }
  return { verified, removed };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [list, directory] = process.argv.slice(2);
  if (!list || !directory || !existsSync(list)) throw new Error('Usage: verify-cached-downloads.mjs <download.lst> <tarballs>');
  console.log(JSON.stringify(verifyCachedDownloads(list, directory)));
}
