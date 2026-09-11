/** Package the Debian NSS, NSPR, and SQLite runtime used by an existing glibc Core. */
import { constants, chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from './pack-utils.mjs';
import { assert, safePath, sha256, verifyNativeHeader, verifyNativeImage } from './verify-artifacts.mjs';

const packages = [
  { name: 'libnss3', component: 'NSS', files: ['libfreebl3.so', 'libfreeblpriv3.so', 'libnss3.so', 'libnssckbi.so', 'libnssdbm3.so', 'libnssutil3.so', 'libsmime3.so', 'libsoftokn3.so', 'libssl3.so', 'libfreebl3.chk', 'libfreeblpriv3.chk', 'libnssdbm3.chk', 'libsoftokn3.chk'] },
  { name: 'libnspr4', component: 'NSPR', files: ['libnspr4.so', 'libplc4.so', 'libplds4.so'] },
  { name: 'libsqlite3-0', component: 'SQLite', files: ['libsqlite3.so.0'] },
];
const receiptPath = 'sources/linux-runtime/receipt.json';
/** Foundational glibc host libraries allowed by staging and installed loader verification. */
export const baseLibraries = new Set(['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libresolv.so.2', 'libutil.so.1', 'libstdc++.so.6', 'libgcc_s.so.1', 'libz.so.1']);

/** Parse one Debian control stanza, including folded checksum lists. */
export function debianFields(text) {
  const result = {};
  let field;
  for (const line of text.trim().split('\n')) {
    if (/^\s/.test(line)) {
      assert(field, 'Debian metadata has an orphan continuation');
      result[field] += `\n${line.trim()}`;
    } else {
      const match = /^([\w-]+):\s*(.*)$/.exec(line);
      assert(match && !Object.hasOwn(result, match[1]), 'Invalid or duplicate Debian metadata field');
      [, field] = match;
      result[field] = match[2];
    }
  }
  return result;
}

/** An installed file must match the exact authenticated archive selected by APT. */
export function verifyInstalledFile(installed, extracted) {
  const hash = sha256(extracted);
  assert(sha256(installed) === hash, `Installed runtime file differs from its Debian archive: ${installed}`);
  return hash;
}

function archiveFile(extracted, name) {
  const file = realpathSync(join(extracted, name));
  const path = relative(extracted, file);
  assert(path && !path.startsWith('..') && !isAbsolute(path) && lstatSync(file).isFile(), `Debian runtime file escapes its archive: ${name}`);
  return file;
}

function acquireDebianRuntime(platform, work) {
  const architecture = platform.includes('-arm64-') ? 'arm64' : 'amd64';
  return packages.map(spec => {
    const folder = join(work, spec.name);
    mkdirSync(folder);
    const installed = debianFields(run('dpkg-query', ['-W', '-f=Package: ${Package}\nStatus: ${Status}\nArchitecture: ${Architecture}\nVersion: ${Version}\nSource: ${source:Package}\nSource-Version: ${source:Version}\n', `${spec.name}:${architecture}`]));
    assert(installed.Package === spec.name && installed.Status === 'install ok installed' && installed.Architecture === architecture, `Runtime package is not installed for ${architecture}: ${spec.name}`);
    const selector = `${spec.name}:${architecture}=${installed.Version}`;
    const records = run('apt-cache', ['show', selector]).trim().split(/\n\s*\n/).map(debianFields)
      .filter(record => record.Package === spec.name && record.Version === installed.Version && record.Architecture === architecture);
    assert(records.length > 0 && records.every(record => record.SHA256 === records[0].SHA256), `APT has no unique archive for ${selector}`);
    const metadata = records[0];
    assert(/^[a-f0-9]{64}$/.test(metadata.SHA256), `APT is missing the SHA256 for ${selector}`);
    const uris = run('apt-get', ['--print-uris', 'download', selector], { cwd: folder }).split('\n').filter(line => line.startsWith("'"));
    assert(uris.length === 1, `APT did not identify one archive URL for ${selector}`);
    const uri = /^'([^']+)' /.exec(uris[0])?.[1];
    assert(uri && /^https?:\/\//.test(uri), `Invalid APT archive URL for ${selector}`);
    run('apt-get', ['download', selector], { cwd: folder });
    const downloads = readdirSync(folder).filter(file => file.endsWith('.deb'));
    assert(downloads.length === 1, `APT did not download one archive for ${selector}`);
    const archive = join(folder, downloads[0]);
    assert(sha256(archive) === metadata.SHA256, `APT archive SHA256 mismatch for ${selector}`);
    const controlText = run('dpkg-deb', ['--field', archive]);
    const control = debianFields(controlText);
    assert(['Package', 'Architecture', 'Version'].every(key => control[key] === installed[key]), `Debian archive identity differs from installed ${selector}`);
    const source = /^(\S+)(?: \(([^)]+)\))?$/.exec(control.Source ?? control.Package);
    assert(source && source[1] === installed.Source && (source[2] ?? control.Version) === installed['Source-Version'], `Debian source version differs from installed ${selector}`);
    const extracted = join(folder, 'extracted');
    run('dpkg-deb', ['--extract', archive, extracted]);
    const paths = run('dpkg-query', ['-L', `${spec.name}:${architecture}`]).trim().split('\n');
    const files = spec.files.map(name => {
      const matches = paths.filter(file => /^\/(?:usr\/)?lib\//.test(file) && basename(file) === name);
      assert(matches.length === 1, `Runtime package ${selector} lacks a unique ${name}`);
      const installedFile = matches[0];
      const from = archiveFile(extracted, installedFile.slice(1));
      return { name, from, sha256: verifyInstalledFile(installedFile, from) };
    });
    const copyright = `/usr/share/doc/${spec.name}/copyright`;
    const copyrightFile = archiveFile(extracted, copyright.slice(1));
    verifyInstalledFile(copyright, copyrightFile);
    const dscUrl = new URL(`${installed.Source}_${installed['Source-Version'].replace(/^\d+:/, '')}.dsc`, uri);
    dscUrl.protocol = 'https:';
    const dsc = run('curl', ['--fail', '--silent', '--show-error', '--location', '--proto', '=https', '--max-time', '60', dscUrl.href]);
    const signed = /^-----BEGIN PGP SIGNED MESSAGE-----\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*?)\r?\n-----BEGIN PGP SIGNATURE-----/.exec(dsc);
    const sourceMetadata = debianFields(signed ? signed[1].replace(/^- /gm, '') : dsc);
    assert(sourceMetadata.Source === installed.Source && sourceMetadata.Version === installed['Source-Version'], `Source archive identity differs from ${selector}`);
    const sourceArchives = (sourceMetadata['Checksums-Sha256'] ?? '').trim().split('\n').map(line => {
      const match = /^([a-f0-9]{64})\s+(\d+)\s+([^/\\\s]+)$/.exec(line);
      assert(match && !['.', '..'].includes(match[3]), `Invalid source archive checksum for ${selector}`);
      return { url: new URL(match[3], dscUrl).href, sha256: match[1], bytes: Number(match[2]) };
    });
    return { name: spec.name, version: installed.Version, architecture, source: { name: installed.Source, version: installed['Source-Version'], dscUrl: dscUrl.href, archives: sourceArchives },
      archive: { url: uri, sha256: metadata.SHA256 }, files, copyright: copyrightFile,
      metadata: { 'binary-control.txt': controlText, 'apt-metadata.json': `${JSON.stringify(metadata, null, 2)}\n`, 'source.dsc': dsc } };
  });
}

function header(file) {
  const bytes = Buffer.alloc(20);
  const fd = openSync(file, 'r');
  try { readSync(fd, bytes); } finally { closeSync(fd); }
  return bytes;
}

/** Every non-glibc/runtime dependency must have its loader name in the owned program directory. */
export function verifyLinuxClosure(directory, prebuild, inspect = file => run('readelf', ['--wide', '--dynamic', file], { env: { ...process.env, LC_ALL: 'C' } })) {
  const machine = prebuild.platform.includes('-arm64-') ? 183 : 62;
  const loader = machine === 183 ? 'ld-linux-aarch64.so.1' : 'ld-linux-x86-64.so.2';
  const external = new Set();
  let elfFiles = 0;
  for (const name of Object.keys(prebuild.files).filter(name => /^(bin|program)\//.test(name))) {
    const file = join(directory, safePath(name));
    const bytes = header(file);
    if (!bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) continue;
    assert(bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === machine, `Foreign ELF architecture in Linux package: ${name}`);
    elfFiles++;
    const dynamic = inspect(file);
    const dependencies = [...dynamic.matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)];
    assert(dependencies.length === (dynamic.match(/\(NEEDED\)/g) ?? []).length, `Unparsed ELF dependency in ${name}`);
    for (const match of dependencies) {
      const library = match[1];
      if (baseLibraries.has(library) || library === loader) { external.add(library); continue; }
      assert(basename(library) === library, `Absolute or relative ELF dependency: ${library}`);
      const provider = `${prebuild.engine.programDirectory}/${library}`;
      assert(Object.hasOwn(prebuild.files, provider), `Unbundled Linux runtime dependency: ${name} needs ${library}`);
      const providerHeader = header(join(directory, provider));
      assert(providerHeader.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && providerHeader.readUInt16LE(18) === machine, `Invalid Linux dependency provider: ${provider}`);
    }
  }
  assert(elfFiles > 0, 'Linux runtime closure has no ELF files');
  return { elfFiles, systemLibraries: [...external].sort() };
}

/** Supplement glibc builds without replacing any existing Core program byte. Musl uses a separate APK recipe. */
export function stageLinuxRuntime(directory, prebuild, { acquire = acquireDebianRuntime, inspect } = {}) {
  if (!prebuild.platform.endsWith('-glibc')) return;
  const register = (path, source = false) => {
    prebuild.files[path] = sha256(join(directory, path));
    if (source && !prebuild.source.files.includes(path)) prebuild.source.files.push(path);
  };
  if (Object.hasOwn(prebuild.files, receiptPath)) {
    const receipt = JSON.parse(readFileSync(join(directory, receiptPath), 'utf8'));
    assert(receipt.platform === prebuild.platform && receipt.packages.length === packages.length, 'Linux runtime receipt has a different platform/package set');
    for (const spec of packages) {
      const record = receipt.packages.find(item => item.name === spec.name);
      assert(record && record.files.length === spec.files.length, `Missing Linux runtime package receipt: ${spec.name}`);
      for (const name of spec.files) {
        const file = `${prebuild.engine.programDirectory}/${name}`;
        const saved = record.files.find(item => item.name === name);
        assert(saved && saved.sha256 === prebuild.files[file] && sha256(join(directory, file)) === saved.sha256, `Linux runtime module receipt mismatch: ${name}`);
      }
    }
    verifyLinuxClosure(directory, prebuild, inspect);
    return;
  }
  const work = mkdtempSync(join(tmpdir(), 'libreoffice-linux-runtime-'));
  try {
    const acquired = acquire(prebuild.platform, work);
    assert(acquired.length === packages.length, 'Linux runtime acquisition did not return the three required packages');
    const records = [];
    const put = (path, bytes, source = false) => {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), bytes, { flag: 'wx' });
      register(path, source);
    };
    for (const spec of packages) {
      const item = acquired.find(item => item.name === spec.name);
      assert(item && item.architecture === (prebuild.platform.includes('-arm64-') ? 'arm64' : 'amd64') && item.files.length === spec.files.length, `Invalid Linux runtime package: ${spec.name}`);
      for (const name of spec.files) {
        const file = item.files.find(file => file.name === name);
        assert(file && sha256(file.from) === file.sha256, `Missing or changed Linux runtime module: ${name}`);
        if (name.includes('.so')) verifyNativeHeader(readFileSync(file.from), prebuild.platform, true);
        const destination = `${prebuild.engine.programDirectory}/${name}`;
        if (existsSync(join(directory, destination))) assert(sha256(join(directory, destination)) === file.sha256, `Linux runtime collides with existing Core file: ${name}`);
        else {
          copyFileSync(file.from, join(directory, destination), constants.COPYFILE_EXCL);
          if (name.includes('.so')) chmodSync(join(directory, destination), 0o755);
        }
        if (name.includes('.so')) verifyNativeImage(join(directory, destination), prebuild.platform, true);
        register(destination);
      }
      const sourceFiles = [];
      for (const [name, bytes] of Object.entries(item.metadata)) {
        const path = `sources/linux-runtime/${spec.name}/${safePath(name)}`;
        put(path, bytes, true);
        sourceFiles.push(path);
      }
      const licensePath = `licenses/linux-runtime/${spec.name}.txt`;
      put(licensePath, readFileSync(item.copyright));
      prebuild.licenses.push({ component: spec.component, spdx: `LicenseRef-${spec.component}-Debian`, path: licensePath });
      const { metadata, copyright, files, ...identity } = item;
      records.push({ ...identity, files: files.map(({ from, ...file }) => file), sourceFiles, licensePath });
    }
    const mpl = 'licenses/linux-runtime/MPL-2.0.txt';
    put(mpl, readFileSync(join(directory, 'licenses/LibreOffice-MPL-2.0.txt')));
    prebuild.licenses.push({ component: 'NSS and NSPR', spdx: 'MPL-2.0', path: mpl });
    const closure = verifyLinuxClosure(directory, prebuild, inspect);
    put(receiptPath, `${JSON.stringify({ platform: prebuild.platform, packages: records, closure }, null, 2)}\n`, true);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
