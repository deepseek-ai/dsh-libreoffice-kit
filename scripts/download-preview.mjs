#!/usr/bin/env node
/** Download a locally-built preview plus its offline dependency closure, verifying GitHub asset digests. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assert, sha256 } from './verify-artifacts.mjs';
import { isMain, sourceRepository, tarballName } from './platform-matrix.mjs';
export function downloadPreview(tag, destination) {
assert(/^v\d+\.\d+\.\d+-[\w.-]+$/.test(tag ?? '') && destination, 'Expected a prerelease tag and directory');
const directory = resolve(destination), version = tag.slice(1);
mkdirSync(directory, { recursive: true });
assert(readdirSync(directory).length === 0, 'Download directory must be empty');
const gh = args => execFileSync('gh', args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
const release = JSON.parse(gh(['api', `repos/${sourceRepository}/releases/tags/${tag}`]));
assert(release.tag_name === tag && !release.draft && release.prerelease, 'Expected the published prerelease');
const files = ['browser-preview.json', 'offline-dependencies.tar', ...['@deepseek-ai/libreoffice-kit', '@deepseek-ai/libreoffice-kit-wasm'].map(name => tarballName({name,version}))];
for (const name of files) {
  const matches = release.assets.filter(asset => asset.name === name);
  assert(matches.length === 1 && matches[0].state === 'uploaded' && matches[0].size > 0
    && matches[0].size < 512 * 1024 * 1024 && /^sha256:[a-f0-9]{64}$/.test(matches[0].digest), `Invalid Release asset: ${name}`);
}
gh(['release', 'download', tag, '--repo', sourceRepository, '--dir', directory, ...files.flatMap(name => ['--pattern', name])]);
for (const name of files) {
  const asset = release.assets.find(asset => asset.name === name);
  assert(statSync(join(directory,name)).size === asset.size && `sha256:${sha256(join(directory,name))}` === asset.digest, `Download checksum differs: ${name}`);
}
const candidate = JSON.parse(readFileSync(join(directory,'browser-preview.json'),'utf8'));
extractOfflineDependencies(directory, candidate);
return directory;
}

/** Validate the complete archive inventory before tar can write any path. */
export function extractOfflineDependencies(directory, candidate) {
  assert(Array.isArray(candidate.dependencies) && candidate.dependencies.length <= 256, 'Invalid dependency inventory');
  const files = new Set();
  const packages = new Set();
  for (const record of candidate.dependencies) {
    assert(typeof record.name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(record.name)
      && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(record.version)
      && !record.name.startsWith('@deepseek-ai/libreoffice-kit')
      && record.file === `dependencies/${tarballName(record)}` && !files.has(record.file) && !packages.has(record.name)
      && /^[a-f0-9]{64}$/.test(record.sha256), 'Noncanonical dependency archive path');
    files.add(record.file); packages.add(record.name);
  }
  const archive = join(directory, 'offline-dependencies.tar');
  assert(candidate.dependencyArchive?.file === 'offline-dependencies.tar'
    && candidate.dependencyArchive.sha256 === sha256(archive)
    && candidate.dependencyArchive.bytes === statSync(archive).size, 'Offline dependencies differ from the candidate');
  const inspect = args => execFileSync('tar', [...args, archive], {encoding:'utf8', timeout:30_000, maxBuffer:1024*1024})
    .trim().split('\n').filter(Boolean);
  const names = inspect(['-tf']);
  assert(names.every(name => name === 'dependencies/' || name === 'dependencies' || files.has(name))
    && new Set(names).size === names.length && [...files].every(name => names.includes(name)), 'Unexpected dependency archive member');
  const listing = inspect(['-tvf']);
  assert(listing.length === names.length && listing.every(line => /^[-d]/.test(line)), 'Dependency archives may not contain links');
  execFileSync('tar', ['-xf', archive, '-C', directory], { timeout:30_000 });
  for (const record of candidate.dependencies) {
    assert(statSync(join(directory, record.file)).isFile() && sha256(join(directory, record.file)) === record.sha256,
      'Extracted dependency checksum differs');
  }
}

if (isMain(import.meta.url)) {
  const tag = process.env.KIT_RELEASE_TAG;
  assert(process.argv.length === 3, 'Usage: KIT_RELEASE_TAG=vX.Y.Z-rcN node scripts/download-preview.mjs <directory>');
  console.log(downloadPreview(tag, process.argv[2]));
}
