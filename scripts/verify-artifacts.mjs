/** Validate staged or installed engine packages without compiling or downloading. */
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { enginePrefix, isMain, nodeRange, readJson, targets } from './platform-matrix.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const payloadRoots = ['assets', 'bin', 'program', 'sources', 'licenses'];

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function sha256(file) {
  const hash = createHash('sha256');
  const fd = openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (let count; (count = readSync(fd, chunk)) !== 0;) hash.update(chunk.subarray(0, count));
  } finally { closeSync(fd); }
  return hash.digest('hex');
}

/** Manifest paths are POSIX relative paths on every host, including Windows. */
export function safePath(value) {
  assert(typeof value === 'string' && value.length > 0 && !/[\\:\x00-\x1f]/.test(value)
    && !value.split('/').some((part) => part === '' || part === '.' || part === '..'), `Unsafe package path: ${value}`);
  return value;
}

export function regularFile(dir, relative) {
  safePath(relative);
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const file = join(dir, ...parts.slice(0, index));
    let stat;
    try { stat = lstatSync(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      throw new Error(`Missing package artifact: ${relative}`, { cause: error });
    }
    assert(index === parts.length ? stat.isFile() : stat.isDirectory(), `Not a regular package file/directory: ${relative}`);
  }
  return join(dir, ...parts);
}

function inventory(dir, prefix) {
  let entries;
  try { entries = readdirSync(join(dir, prefix), { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  assert(lstatSync(join(dir, prefix)).isDirectory(), `Not a regular payload directory: ${prefix}`);
  return entries.flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    assert(entry.isFile() || entry.isDirectory(), `Symlink or special payload file: ${name}`);
    return entry.isDirectory() ? inventory(dir, name) : [name];
  });
}

export function verifyNoInstallHooks(manifest, allowWorkspace = false) {
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert(!Object.hasOwn(manifest.scripts ?? {}, hook), `${manifest.name}: forbidden install lifecycle ${hook}`);
  }
  assert(manifest.gypfile !== true && manifest.bin === undefined, `${manifest.name}: engine packages must not register install builds or CLI bins`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      assert(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) || (allowWorkspace && name.startsWith(`${enginePrefix}-`) && version === 'workspace:*'), `${manifest.name}: ${field} must pin a published version: ${name}`);
    }
  }
}

/** Validate metadata independently of whether the target has been built. */
export function verifyEngineMetadata(manifest, prebuild) {
  verifyNoInstallHooks(manifest);
  assert(manifest.type === 'module' && manifest.engines?.node === nodeRange, 'Engine package requires ESM and the declared Node baseline');
  assert(manifest.exports?.['./prebuilds.json'] === './prebuilds.json'
    && manifest.exports?.['./package.json'] === './package.json', 'Engine package must export prebuilds.json and package.json');
  assert(prebuild.schemaVersion === 1 && ['unbuilt', 'built'].includes(prebuild.status), 'Unsupported engine schema/status');
  assert(prebuild.version === manifest.version && manifest.name === `${enginePrefix}-${prebuild.platform}`, 'Engine package identity/version mismatch');
  const target = targets[prebuild.platform];
  const engine = prebuild.engine;
  if (engine?.glibcMinimum !== undefined) {
    assert(target?.libc === 'glibc' && typeof engine.glibcMinimum === 'string'
      && /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(engine.glibcMinimum)
      && engine.glibcMinimum.split('.').every(part => Number.isSafeInteger(Number(part))), 'Invalid native glibcMinimum');
  }
  const exact = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  if (prebuild.platform === 'wasm') {
    assert(JSON.stringify(manifest.os) === '["linux"]' && manifest.cpu === undefined && manifest.libc === undefined, 'WASM package must install only on Linux, for every CPU and libc');
    assert(engine?.kind === 'wasm' && engine.loader === 'assets/soffice.cjs' && engine.wasm === 'assets/soffice.wasm'
      && engine.data === 'assets/soffice.data' && engine.metadata === 'assets/soffice.data.js.metadata'
      && engine.programDirectory === '/instdir/program', 'Unsupported WASM engine paths');
  } else {
    assert(target && exact(manifest.os, [target.os]) && exact(manifest.cpu, [target.cpu])
      && (target.libc ? exact(manifest.libc, [target.libc]) : manifest.libc === undefined), 'Native platform disagrees with package os/cpu/libc');
    assert(engine?.kind === 'native' && engine.executable === `bin/libreoffice-kit${target.os === 'win32' ? '.exe' : ''}`
      && typeof engine.programDirectory === 'string' && (engine.programDirectory === 'program' || engine.programDirectory.startsWith('program/')), 'Unsupported native engine paths');
    safePath(engine.programDirectory);
  }
  assert(prebuild.files && typeof prebuild.files === 'object' && !Array.isArray(prebuild.files), 'Engine files must be a hash inventory');
  for (const [file, hash] of Object.entries(prebuild.files)) {
    safePath(file);
    assert(payloadRoots.includes(file.split('/')[0]) && hashPattern.test(hash), `Invalid file inventory entry: ${file}`);
  }
  assert(Array.isArray(prebuild.licenses), 'Engine licenses must be an array');
  if (prebuild.status === 'unbuilt') {
    assert(Object.keys(prebuild.files).length === 0 && prebuild.source === null && prebuild.licenses.length === 0,
      'Unbuilt target must not claim built files or source/license receipts');
    return;
  }
  const source = prebuild.source;
  assert(source && /^https:\/\//.test(source.repository) && /^[a-f0-9]{40}$/.test(source.revision)
    && typeof source.version === 'string' && source.version.length > 0 && Array.isArray(source.files) && source.files.length > 0,
  'Built engine requires source repository, full revision, version, and packaged build inputs');
  assert(new Set(source.files).size === source.files.length, 'Duplicate source manifest paths');
  for (const file of source.files) assert(file.startsWith('sources/') && Object.hasOwn(prebuild.files, file), `Missing hashed source: ${file}`);
  assert(prebuild.licenses.some((license) => license.component === 'LibreOffice' && license.spdx === 'MPL-2.0'), 'Missing LibreOffice MPL-2.0 license');
  for (const license of prebuild.licenses) {
    assert(typeof license.component === 'string' && license.component.length > 0 && typeof license.spdx === 'string' && license.spdx.length > 0
      && typeof license.path === 'string' && license.path.startsWith('licenses/') && Object.hasOwn(prebuild.files, license.path), 'Missing hashed redistribution license');
  }
}

/** Header-only checks accept minimal test fixtures; they are not release validation. */
export function verifyNativeHeader(bytes, platform, shared = false) {
  const target = targets[platform];
  assert(target, `Unknown native target: ${platform}`);
  if (target.os === 'linux') {
    assert(bytes.length >= 64 && bytes.readUInt32LE(0) === 0x464c457f && bytes[4] === 2 && bytes[5] === 1, 'Expected little-endian ELF64 image');
    assert(bytes.readUInt16LE(18) === (target.cpu === 'x64' ? 62 : 183), 'Wrong ELF architecture');
    assert((shared ? [3] : [2, 3]).includes(bytes.readUInt16LE(16)), 'Wrong ELF executable/library type');
  } else if (target.os === 'darwin') {
    assert(bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf, 'Expected thin Mach-O 64-bit image');
    assert(bytes.readUInt32LE(4) === (target.cpu === 'x64' ? 0x01000007 : 0x0100000c), 'Wrong Mach-O architecture');
    assert((shared ? [6, 8] : [2]).includes(bytes.readUInt32LE(12)), 'Wrong Mach-O executable/library type');
  } else {
    assert(bytes.length >= 64 && bytes.readUInt16LE(0) === 0x5a4d, 'Expected PE executable');
    const pe = bytes.readUInt32LE(60);
    assert(pe >= 64 && pe + 26 <= bytes.length && bytes.readUInt32LE(pe) === 0x4550, 'Truncated or invalid PE header');
    assert(bytes.readUInt16LE(pe + 4) === (target.cpu === 'x64' ? 0x8664 : 0xaa64), 'Wrong PE architecture');
    assert(bytes.readUInt16LE(pe + 24) === 0x20b && (bytes.readUInt16LE(pe + 22) & 0x2002) === (shared ? 0x2002 : 2), 'Wrong PE32+ executable/DLL type');
  }
}

/** Require executable code records in addition to the format/architecture header. */
export function verifyNativeImage(file, platform, shared = false) {
  const bytes = readFileSync(file);
  verifyNativeHeader(bytes, platform, shared);
  const target = targets[platform];
  if (process.platform !== 'win32' && target.os !== 'win32') assert((statSync(file).mode & 0o111) !== 0, 'Native engine is not executable');
  if (target.os === 'linux') {
    const offset = Number(bytes.readBigUInt64LE(32));
    const width = bytes.readUInt16LE(54);
    const count = bytes.readUInt16LE(56);
    assert((shared || bytes.readBigUInt64LE(24) !== 0n) && width >= 56 && count > 0 && offset >= 64 && offset + width * count <= bytes.length, 'ELF image has no executable program table');
    let code = false;
    let interpreter;
    for (let index = 0; index < count; index++) {
      const record = offset + index * width;
      const kind = bytes.readUInt32LE(record);
      const start = Number(bytes.readBigUInt64LE(record + 8));
      const size = Number(bytes.readBigUInt64LE(record + 32));
      assert(start >= 0 && size >= 0 && start + size <= bytes.length, 'ELF segment outside image');
      if (kind === 1 && (bytes.readUInt32LE(record + 4) & 1) && size > 0) code = true;
      if (kind === 3) interpreter = bytes.subarray(start, start + size).toString('utf8').replace(/\0.*$/, '');
    }
    assert(code, 'ELF image has no executable segment');
    if (interpreter) assert(/ld-linux/.test(interpreter), 'ELF interpreter disagrees with declared libc');
  } else if (target.os === 'darwin') {
    const count = bytes.readUInt32LE(16);
    const size = bytes.readUInt32LE(20);
    assert(count > 0 && size >= count * 8 && 32 + size <= bytes.length, 'Mach-O image has no load commands');
    let offset = 32;
    let code = false;
    for (let index = 0; index < count; index++) {
      assert(offset + 8 <= 32 + size, 'Truncated Mach-O load command');
      const command = bytes.readUInt32LE(offset);
      const length = bytes.readUInt32LE(offset + 4);
      assert(length >= 8 && offset + length <= 32 + size, 'Invalid Mach-O load command');
      if (command === 0x19 && length >= 72) {
        const start = Number(bytes.readBigUInt64LE(offset + 40));
        const lengthOnDisk = Number(bytes.readBigUInt64LE(offset + 48));
        assert(start + lengthOnDisk <= bytes.length, 'Mach-O segment outside image');
        if ((bytes.readUInt32LE(offset + 60) & 4) && lengthOnDisk > 0) code = true;
      }
      offset += length;
    }
    assert(code && offset === 32 + size, 'Mach-O image has no complete executable segment');
  } else {
    const pe = bytes.readUInt32LE(60);
    const count = bytes.readUInt16LE(pe + 6);
    const optionalSize = bytes.readUInt16LE(pe + 20);
    const sections = pe + 24 + optionalSize;
    assert(optionalSize >= 112 && count > 0 && sections + count * 40 <= bytes.length && (shared || bytes.readUInt32LE(pe + 40) !== 0), 'PE image has no executable sections');
    let code = false;
    for (let index = 0; index < count; index++) {
      const record = sections + index * 40;
      const size = bytes.readUInt32LE(record + 16);
      const start = bytes.readUInt32LE(record + 20);
      assert(start + size <= bytes.length, 'PE section outside image');
      if ((bytes.readUInt32LE(record + 36) & 0x20000000) && size > 0) code = true;
    }
    assert(code, 'PE image has no executable code');
  }
}

function verifyPayload(dir, prebuild, actual) {
  const declared = Object.keys(prebuild.files).sort();
  actual.sort();
  assert(JSON.stringify(declared) === JSON.stringify(actual), 'Payload inventory contains missing or undeclared files');
  for (const file of declared) assert(sha256(regularFile(dir, file)) === prebuild.files[file], `Artifact checksum mismatch: ${file}`);
  for (const license of prebuild.licenses) assert(readFileSync(regularFile(dir, license.path), 'utf8').trim().length > 0, `Empty license: ${license.path}`);
}

/** Full payload gate: checksums, source/license closure, resources, and real engine exports. */
export function verifyEnginePackage(dir) {
  const manifest = readJson(regularFile(dir, 'package.json'));
  const prebuild = readJson(regularFile(dir, 'prebuilds.json'));
  verifyEngineMetadata(manifest, prebuild);
  assert(prebuild.status === 'built', `${prebuild.platform}: unbuilt target cannot be packed or released`);
  verifyPayload(dir, prebuild, payloadRoots.flatMap((prefix) => inventory(dir, prefix)));
  const declared = Object.keys(prebuild.files);
  const engine = prebuild.engine;
  if (engine.kind === 'native') {
    verifyNativeImage(regularFile(dir, engine.executable), prebuild.platform);
    assert(declared.some((file) => file.startsWith(`${engine.programDirectory}/`)), 'Native engine has no program resources');
  } else {
    for (const key of ['loader', 'wasm', 'data', 'metadata']) regularFile(dir, engine[key]);
    const module = new WebAssembly.Module(readFileSync(join(dir, engine.wasm)));
    const exports = new Set(WebAssembly.Module.exports(module).filter((entry) => entry.kind === 'function').map((entry) => entry.name.replace(/^_/, '')));
    for (const name of ['dsh_lok_initialize', 'dsh_lok_document_load', 'dsh_lok_document_save_pdf', 'dsh_lok_document_export', 'dsh_lok_document_destroy', 'dsh_lok_destroy', 'dsh_lok_error', 'malloc', 'free']) {
      assert(exports.has(name), `WASM engine missing conversion export: ${name}`);
    }
    const dataSize = statSync(join(dir, engine.data)).size;
    const metadata = readJson(join(dir, engine.metadata));
    assert(dataSize > 0 && Array.isArray(metadata.files) && metadata.files.length > 0, 'WASM data has no packaged resources');
    const names = new Set();
    const ranges = [];
    for (const file of metadata.files) {
      assert(typeof file.filename === 'string' && (file.filename.startsWith('/instdir/')
        || ['/android/default-document/example.odt', '/android/default-document/example_test.ods'].includes(file.filename))
        && !names.has(file.filename), 'Invalid or duplicate WASM resource path');
      safePath(file.filename.slice(1));
      names.add(file.filename);
      assert(Number.isSafeInteger(file.start) && Number.isSafeInteger(file.end) && file.start >= 0 && file.end >= file.start && file.end <= dataSize, 'WASM resource outside data file');
      ranges.push([file.start, file.end]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    assert(ranges.every((range, index) => index === 0 || ranges[index - 1][1] <= range[0]), 'Overlapping WASM data ranges');
    assert([...names].some((name) => name.startsWith(`${engine.programDirectory}/`)), 'WASM data lacks program resources');
    assert(/\bmodule\[?[^;]*exports|\bmodule\.exports/.test(readFileSync(join(dir, engine.loader), 'utf8')), 'WASM loader must provide a Node CommonJS factory');
  }
  return { name: manifest.name, platform: prebuild.platform, files: declared.length };
}

if (isMain(import.meta.url)) {
  console.log(JSON.stringify(verifyEnginePackage(resolve(process.argv[2] ?? '.'))));
}
