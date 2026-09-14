/** Derive the glibc floor from ELF version requirements after all runtime libraries are staged. */
import { closeSync, openSync, readSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { regularFile } from '../../scripts/verify-artifacts.mjs';

/** Parse GNU/LLVM readelf version-needs records; exported versions are not requirements. */
export function neededGlibcVersions(output) {
  const versions = [];
  let needs = false;
  for (const line of output.split('\n')) {
    if (/^Version /.test(line)) needs = line.startsWith('Version needs section ');
    if (!needs) continue;
    const tag = /\bName:\s+(GLIBC_\S+)/.exec(line)?.[1];
    if (!tag) continue;
    // glibc 2.36 added this loader capability: https://sourceware.org/pipermail/glibc-cvs/2022q2/078142.html
    const version = tag === 'GLIBC_ABI_DT_RELR' ? '2.36' : tag.slice(6);
    if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error(`Unsupported glibc version requirement: ${tag}`);
    versions.push(version);
  }
  return versions;
}

/** Read every declared bin/program ELF, including bundled dependencies; no native code is executed. */
export function glibcMinimum(directory, files, { readelf = 'readelf' } = {}) {
  const versions = [];
  for (const file of files) {
    if (!/^(bin|program)\//.test(file)) continue;
    const path = regularFile(directory, file);
    const descriptor = openSync(path, 'r');
    const magic = Buffer.alloc(4);
    let count;
    try { count = readSync(descriptor, magic); } finally { closeSync(descriptor); }
    if (count !== 4 || magic.readUInt32LE() !== 0x464c457f) continue;
    const result = spawnSync(readelf, ['--version-info', '--wide', path], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, LC_ALL: 'C' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`readelf failed for ${file}: ${result.stderr}`);
    versions.push(...neededGlibcVersions(result.stdout));
  }
  if (!versions.length) throw new Error('No glibc version requirements found in native ELF payloads.');
  return versions.sort((left, right) => left.localeCompare(right, 'en', { numeric: true })).at(-1);
}
