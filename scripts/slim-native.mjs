/** Remove desktop-only content and nonessential symbols from staged conversion engines. */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJson } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';

function files(directory, prefix = '') {
  return readdirSync(join(directory, prefix)).sort().flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    const info = lstatSync(join(directory, path));
    assert(info.isDirectory() || info.isFile(), `Native payload contains a special file: ${path}`);
    return info.isDirectory() ? files(directory, path) : [path];
  });
}

/**
 * Remove a duplicate macOS build alias, disabled components and desktop resources.
 * @param directory - Staged native package directory.
 * @param platform - Native engine target.
 * @param programDirectory - Package-relative directory holding Core's shared libraries.
 * @returns Removed paths and their uncompressed byte count.
 */
export function pruneNativePayload(directory, platform, programDirectory) {
  const removed = [];
  let removedBytes = 0;
  const remove = path => {
    if (!existsSync(join(directory, path))) return;
    const info = lstatSync(join(directory, path));
    assert(info.isFile() || info.isDirectory(), `Cannot prune a special file: ${path}`);
    removedBytes += info.isFile() ? info.size : files(join(directory, path)).reduce((size, file) => size + statSync(join(directory, path, file)).size, 0);
    rmSync(join(directory, path), { recursive: info.isDirectory() });
    removed.push(path);
  };
  for (const name of readdirSync(join(directory, 'program')).sort())
    if (name === 'sdk' || /^LibreOffice(?:Dev)?[0-9.]+_SDK$/.test(name)) remove(`program/${name}`);
  const darwin = platform.startsWith('darwin-');
  const windows = platform.startsWith('win32-');
  const resources = `${dirname(programDirectory).replaceAll('\\', '/')}/${darwin ? 'Resources' : 'share'}`;
  const programResources = darwin ? resources : programDirectory;
  if (darwin) {
    const alias = `${dirname(programDirectory).replaceAll('\\', '/')}/MacOS/urelibs`;
    if (existsSync(join(directory, alias))) {
      const originals = files(join(directory, programDirectory));
      const copies = files(join(directory, alias));
      assert(JSON.stringify(originals) === JSON.stringify(copies) && originals.every(file =>
        sha256(join(directory, programDirectory, file)) === sha256(join(directory, alias, file))), 'Core build-tool alias differs from the runtime libraries');
      remove(alias);
    }
  }
  if (darwin) {
    const contents = dirname(programDirectory).replaceAll('\\', '/');
    remove(`${contents}/Library/Spotlight`);
    const plugins = `${contents}/PlugIns`;
    if (existsSync(join(directory, plugins)))
      for (const name of readdirSync(join(directory, plugins)).sort())
        if (name.endsWith('.appex')) remove(`${plugins}/${name}`);
  }
  const launchers = darwin ? `${dirname(programDirectory).replaceAll('\\', '/')}/MacOS` : programDirectory;
  for (const name of ['soffice', 'soffice.bin', 'soffice.exe', 'unopkg', 'unopkg.bin', 'unopkg.exe', 'gengal', 'gengal.bin', 'gengal.exe', 'senddoc', 'unoinfo', 'unoinfo.exe', 'xpdfimport', 'xpdfimport.exe'])
    remove(`${launchers}/${name}`);
  for (const name of ['gallery', 'template', 'wizards', 'tipoftheday', 'xpdfimport']) remove(`${resources}/${name}`);
  remove(`${dirname(programDirectory).replaceAll('\\', '/')}/wizards`);
  if (windows) {
    for (const name of ['shlxthdl', 'shell', 'soffice.com', 'unopkg.com', 'swriter.exe', 'scalc.exe', 'simpress.exe', 'sdraw.exe',
      'smath.exe', 'sbase.exe', 'sweb.exe', 'soffice_safe.exe', 'quickstart.exe', 'uno.exe', 'senddoc.exe', 'regview.exe', 'spsupp_helper.exe'])
      remove(`${programDirectory}/${name}`);
    for (const name of readdirSync(join(directory, programDirectory)).sort())
      if (/^cli_.*\.config$/i.test(name)) remove(`${programDirectory}/${name}`);
  }
  for (const name of ['basic', 'Scripts']) remove(`${resources}/${name}`);
  remove(`${darwin ? resources : dirname(programDirectory).replaceAll('\\', '/')}/presets/basic`);
  for (const name of ['access2base.py', 'scriptforge.py', 'scriptforge.pyi']) remove(`${programResources}/${name}`);
  for (const location of new Set([resources, programResources])) {
    if (!existsSync(join(directory, location))) continue;
    for (const name of readdirSync(join(directory, location)).sort())
      if (/\.icns$|^intro(?:-highres)?\.png$/.test(name)) remove(`${location}/${name}`);
  }
  const excludedLibraries = /^(?:lib)?(?:clucene|ucpchelp1|helplinkerlo|ucpdav1|ucpcmis1lo|ucpftp1|LanguageToollo|pdfimportlo|ldapbe2lo|curl)(?:[.\d-].*)?\.(?:dylib|so(?:\..*)?|dll)$/i;
  const windowsLibraries = /^(?:libcrypto-3|libssl-3|reg_dlls|shlxtmsi|sellangmsi|reg4allmsdoc|qslnkmsi|sdqsmsi|instooofiltmsi|sn_tools|so_activex|spsupp_x64|spsupp_x86|inprocserv|cli_.*|policy\.1\.0\.cli_.*)\.dll$/i;
  const services = join(directory, programResources, 'services/services.rdb');
  for (const name of readdirSync(join(directory, programDirectory)).sort()) {
    if (!excludedLibraries.test(name) && !(windows && windowsLibraries.test(name))) continue;
    assert(!existsSync(services) || !readFileSync(services, 'utf8').includes(`/${name}`),
      `Removed component remains registered: ${name}; reconfigure Core with the current component selection`);
    remove(`${programDirectory}/${name}`);
  }
  const config = `${resources}/config`;
  if (existsSync(join(directory, config))) {
    for (const name of readdirSync(join(directory, config)).sort())
      if (/^images(?:_[a-z0-9_]+)?\.zip$/.test(name)) remove(`${config}/${name}`);
    const ui = `${config}/soffice.cfg`;
    if (existsSync(join(directory, ui))) {
      for (const file of files(join(directory, ui)))
        if (basename(file).startsWith('notebookbar') || /(?:^|\/)(?:toolbar|menubar)\//.test(file)) remove(`${ui}/${file}`);
    }
  }
  return { removed, removedBytes };
}

function header(file) {
  const buffer = Buffer.alloc(4);
  const descriptor = openSync(file, 'r');
  try { readSync(descriptor, buffer, 0, 4, 0); }
  finally { closeSync(descriptor); }
  return buffer.readUInt32LE();
}

/**
 * Strip symbols while retaining dynamic exports and macOS loadable signatures.
 * Distribution-provided Linux runtime modules retain their authenticated bytes.
 * @param directory - Staged native package directory.
 * @param platform - Native engine target; Windows PE files are retained unchanged.
 * @param execute - Synchronous tool runner, injectable for metadata tests.
 * @returns Changed files and total sizes before and after symbol cleanup.
 */
export function stripNativePayload(directory, platform, execute = run) {
  const stripped = [];
  let beforeBytes = 0;
  let afterBytes = 0;
  const receipt = join(directory, 'sources/linux-runtime/receipt.json');
  const retained = existsSync(receipt)
    ? new Set(readJson(receipt).packages.flatMap(pkg => pkg.files.map(file => file.name))) : new Set();
  for (const prefix of ['bin', 'program']) {
    for (const path of files(directory, prefix)) {
      const file = join(directory, path);
      const magic = header(file);
      const darwin = platform.startsWith('darwin-') && magic === 0xfeedfacf;
      const linux = platform.startsWith('linux-') && magic === 0x464c457f;
      if (!darwin && !linux) continue;
      if (linux && (retained.has(basename(file)) || (/\.so(?:\..*)?$/.test(file) && existsSync(file.replace(/\.so(?:\..*)?$/, '.chk'))))) continue;
      beforeBytes += statSync(file).size;
      if (darwin) {
        execute('strip', ['-S', '-x', file]);
        execute('codesign', ['--force', '--sign', '-', '--timestamp=none', file]);
        execute('codesign', ['--verify', file]);
      } else execute('strip', ['--strip-unneeded', file]);
      afterBytes += statSync(file).size;
      stripped.push(path);
    }
  }
  return { stripped, beforeBytes, afterBytes };
}
