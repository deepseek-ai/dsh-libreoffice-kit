/** Acquire the audited Alpine 3.22 runtime libraries and their corresponding source notices. */
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { run } from '../../scripts/pack-utils.mjs';
import { assert, sha256 } from '../../scripts/verify-artifacts.mjs';

/** Exact APK identities, loader names, aports revisions, and source checksums. */
export const alpineRuntimePackages = JSON.parse(readFileSync(new URL('./alpine-runtime.json', import.meta.url), 'utf8'));

/** Validate APK identity fields while retaining repeated dependency/provides metadata. */
export function verifyAlpineMetadata(text, spec, architecture) {
  const fields = {};
  for (const line of text.split('\n').filter(line => line && !line.startsWith('#'))) {
    const match = /^(\w+) = (.*)$/.exec(line);
    assert(match, 'Invalid Alpine package metadata');
    (fields[match[1]] ??= []).push(match[2]);
  }
  const expected = { pkgname: spec.name, pkgver: spec.version, arch: architecture, origin: spec.source.origin, commit: spec.source.commit, license: spec.spdx };
  for (const [key, value] of Object.entries(expected)) assert(fields[key]?.length === 1 && fields[key][0] === value, `Unaudited Alpine ${key} for ${spec.name}`);
  assert(fields.datahash?.length === 1 && /^[a-f0-9]{64}$/.test(fields.datahash[0]), `Invalid Alpine data hash for ${spec.name}`);
  return fields;
}

function download(url, destination, algorithm, expected, execute) {
  execute('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--proto-redir', '=https', '--max-time', '150', '--output', destination, url]);
  assert(createHash(algorithm).update(readFileSync(destination)).digest('hex') === expected, `Alpine download checksum mismatch: ${url}`);
  return destination;
}

function sourceNotices(spec, folder, execute) {
  const source = spec.source;
  const base = `https://raw.githubusercontent.com/alpinelinux/aports/${source.commit}/main/${source.origin}/`;
  const apkbuild = download(`${base}APKBUILD`, join(folder, 'APKBUILD'), 'sha256', source.apkbuildSha256, execute);
  const metadata = { APKBUILD: readFileSync(apkbuild, 'utf8') };
  for (const item of source.files) {
    const file = download(`${base}${item.name}`, join(folder, item.name), 'sha512', item.sha512, execute);
    metadata[item.name] = readFileSync(file, 'utf8');
  }
  const archives = [{ ...source.archive }];
  let notices;
  if (source.licenseFile) {
    const item = source.licenseFile;
    const fetchedUrl = `https://distfiles.alpinelinux.org/distfiles/v3.22/${item.name}`;
    const file = download(fetchedUrl, join(folder, item.name), 'sha512', item.sha512, execute);
    notices = `${item.url}\n\n${readFileSync(file, 'utf8')}`;
    archives.push({ ...item, fetchedUrl });
  } else {
    const archive = download(source.archive.url, join(folder, source.archive.name), 'sha512', source.archive.sha512, execute);
    notices = source.licensePaths.map(path => `${path}\n\n${execute('tar', ['--extract', '--to-stdout', '--file', archive, path])}`).join('\n\n');
  }
  const copyright = join(folder, 'copyright');
  writeFileSync(copyright, `${notices.trimEnd()}\n`);
  return { copyright, metadata, source: { name: source.origin, version: spec.version, aportsCommit: source.commit, apkbuildUrl: `${base}APKBUILD`, apkbuildSha256: source.apkbuildSha256, archives,
    files: source.files.map(item => ({ ...item, url: `${base}${item.name}` })) } };
}

/** Verify exact installed versions before acquiring any library; APK scripts and APKBUILD are never executed. */
export function acquireAlpineRuntime(platform, work, execute = run) {
  assert(['linux-arm64-musl', 'linux-x64-musl'].includes(platform), `Unsupported Alpine target: ${platform}`);
  const architecture = platform === 'linux-arm64-musl' ? 'aarch64' : 'x86_64';
  assert(execute('apk', ['--print-arch']).trim() === architecture, `Alpine builder architecture differs from ${platform}`);
  for (const spec of alpineRuntimePackages) {
    const installed = execute('apk', ['info', '--installed', '--verbose', `${spec.name}=${spec.version}`]).trim();
    assert(installed === `${spec.name}-${spec.version}`, `Unaudited installed Alpine version: ${spec.name}`);
  }
  return alpineRuntimePackages.map(spec => {
    const folder = join(work, spec.name);
    mkdirSync(folder);
    const url = `https://dl-cdn.alpinelinux.org/alpine/v3.22/main/${architecture}/${spec.name}-${spec.version}.apk`;
    const archive = download(url, join(folder, `${spec.name}-${spec.version}.apk`), 'sha256', spec.apkSha256[architecture], execute);
    const verification = execute('apk', ['verify', archive]);
    const archiveSha256 = sha256(archive);
    const control = execute('tar', ['--ignore-zeros', '--extract', '--to-stdout', '--file', archive, '.PKGINFO']);
    verifyAlpineMetadata(control, spec, architecture);
    const extracted = join(folder, 'extracted');
    mkdirSync(extracted);
    execute('tar', ['--ignore-zeros', '--extract', '--file', archive, '--directory', extracted, 'usr/lib']);
    const files = spec.files.map(name => {
      const from = realpathSync(join(extracted, 'usr/lib', name));
      const path = relative(extracted, from);
      assert(path && !path.startsWith('..') && !isAbsolute(path) && lstatSync(from).isFile(), `Alpine runtime file escapes its archive: ${name}`);
      const hash = sha256(from);
      assert(hash === sha256(`/usr/lib/${name}`), `Installed runtime file differs from its Alpine archive: ${name}`);
      return { name, from, sha256: hash };
    });
    const { copyright, metadata, source } = sourceNotices(spec, folder, execute);
    return { name: spec.name, version: spec.version, architecture, source, archive: { url, sha256: archiveSha256 }, files, copyright,
      metadata: { ...metadata, 'binary-control.txt': control, 'apk-verification.txt': verification || 'apk verify exited 0 using the builder trusted keys.\n' } };
  });
}
