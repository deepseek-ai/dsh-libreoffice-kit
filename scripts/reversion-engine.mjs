/** Change only two version fields while preserving every payload byte and tar mode. */
import { visitTar } from './publication-privacy.mjs';
import { assert } from './verify-artifacts.mjs';

export function reversionEngineTar(bytes, { name, platform, fromVersion, version }) {
  const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
  assert(semver.test(fromVersion) && semver.test(version) && version !== fromVersion
    && version.split('-')[0] === fromVersion.split('-')[0], 'Version-only repacking requires distinct versions of the same base release');
  const chunks = [];
  let copied = 0;
  const changed = new Set();
  visitTar(bytes, ({ name: file, data, type, extended, headerOffset, endOffset }) => {
    if (!['package/package.json', 'package/prebuilds.json'].includes(file)) return;
    assert(type === '0' && Object.keys(extended).length === 0, 'Version metadata must be a regular USTAR entry');
    const metadata = JSON.parse(data.toString('utf8'));
    assert(metadata.version === fromVersion, 'Source engine version mismatch');
    assert(file.endsWith('/package.json') ? metadata.name === name
      : metadata.platform === platform && metadata.status === 'built', 'Source engine identity/status mismatch');
    const replacement = Buffer.from(`${JSON.stringify({ ...metadata, version }, null, 2)}\n`);
    const header = Buffer.from(bytes.subarray(headerOffset, headerOffset + 512));
    header.write(replacement.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    header.fill(32, 148, 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    chunks.push(bytes.subarray(copied, headerOffset), header, replacement, Buffer.alloc((512 - replacement.length % 512) % 512));
    copied = endOffset;
    changed.add(file);
  });
  assert(changed.size === 2, 'Version repacking requires both engine metadata files');
  chunks.push(bytes.subarray(copied));
  return Buffer.concat(chunks);
}
