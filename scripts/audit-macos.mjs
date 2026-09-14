/** Audit packaged Mach-O architecture, deployment versions, signatures, and dynamic library closure. */
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assert } from './verify-artifacts.mjs';
import { isMain, readJson } from './platform-matrix.mjs';

function execute(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  assert(result.status === 0, `${command} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * Resolve a load command inside the package, permitting only Apple's system libraries outside it.
 * @param dependency - Mach-O load-command path.
 * @param file - Loading binary path.
 * @param executable - Conversion helper path.
 * @param rpaths - Binary's LC_RPATH entries.
 * @param directory - Engine package root.
 * @returns The resolved package path or system library path.
 */
export function resolveDependency(dependency, file, executable, rpaths, directory) {
  if (dependency.startsWith('/usr/lib/') || dependency.startsWith('/System/Library/')) return dependency;
  const expand = value => value.replace(/^@loader_path(?=\/|$)/, dirname(file)).replace(/^@executable_path(?=\/|$)/, dirname(executable));
  const candidates = dependency.startsWith('@rpath/')
    ? rpaths.map(path => join(expand(path), dependency.slice('@rpath/'.length)))
    : [expand(dependency)];
  const found = candidates.find(path => isAbsolute(path) && existsSync(path));
  assert(found, `Unresolved Mach-O dependency ${dependency} in ${relative(directory, file)}`);
  const resolved = realpathSync(found);
  const local = relative(realpathSync(directory), resolved);
  assert(!local.startsWith('..') && !isAbsolute(local), `Mach-O dependency escapes the package: ${dependency}`);
  return local.replaceAll('\\', '/');
}

/**
 * Inspect every Mach-O in a checksummed engine package on its matching macOS host.
 * @param directory - Staged or installed engine package root.
 * @returns Architecture, deployment maximum, and per-binary dependency records.
 */
export function auditMacOS(directory) {
  assert(process.platform === 'darwin', 'Mach-O qualification requires macOS');
  const manifest = readJson(join(directory, 'prebuilds.json'));
  assert(manifest.platform === `darwin-${process.arch}`, 'Mach-O qualification requires the matching CPU');
  const architecture = process.arch === 'arm64' ? 'arm64' : 'x86_64';
  const executable = join(directory, manifest.engine.executable);
  const files = [];
  for (const name of Object.keys(manifest.files)) {
    const file = join(directory, name);
    const fd = openSync(file, 'r');
    const header = Buffer.alloc(16);
    try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
    if (header.readUInt32LE() !== 0xfeedfacf) continue;
    assert(execute('lipo', ['-archs', file]).trim() === architecture, `Wrong Mach-O CPU: ${name}`);
    execute('codesign', ['--verify', file]);
    const commands = execute('otool', ['-l', file]).split(/Load command \d+\n/);
    const rpaths = commands.filter(command => /cmd LC_RPATH\b/.test(command)).map(command => command.match(/\n\s+path (.+) \(offset/)[1]);
    const minimum = commands.map(command => /cmd LC_BUILD_VERSION\b/.test(command) ? command.match(/\n\s+minos ([\d.]+)/)?.[1]
      : /cmd LC_VERSION_MIN_MACOSX\b/.test(command) ? command.match(/\n\s+version ([\d.]+)/)?.[1] : undefined).find(Boolean);
    assert(minimum && (Number(minimum.split('.')[0]) < 11 || /^11(?:\.0){0,2}$/.test(minimum)), `Mach-O requires macOS newer than the declared 11.0 minimum: ${name} (${minimum})`);
    const dependencies = commands.filter(command => /cmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LOAD_UPWARD_DYLIB)\b/.test(command))
      .map(command => command.match(/\n\s+name (.+) \(offset/)[1])
      .map(dependency => ({ dependency, resolved: resolveDependency(dependency, file, header.readUInt32LE(12) === 2 ? file : executable, rpaths, directory) }));
    files.push({ file: name, minimum, dependencies });
  }
  assert(files.some(record => record.file === manifest.engine.executable), 'Mach-O audit did not find the conversion helper');
  return { architecture, deploymentTarget: '11.0', signedFiles: files.length, files };
}

if (isMain(import.meta.url)) console.log(JSON.stringify(auditMacOS(resolve(process.argv[2])), null, 2));
