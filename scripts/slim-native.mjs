/** Remove desktop-only content and nonessential symbols from staged conversion engines. */
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { readJson } from './platform-matrix.mjs';
import { run } from './pack-utils.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';
import { nativeUiResources, darwinUiResources, nativeDesktopResources, darwinDesktopResources } from './native-resource-policy.mjs';

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
 * @param inspectMachO - Read Mach-O load commands; injectable for metadata tests.
 * @returns Removed paths and their uncompressed byte count.
 */
export function pruneNativePayload(directory, platform, programDirectory, inspectMachO = file => run('otool', ['-l', file])) {
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
  if (darwin)
    for (const name of ['regview', 'uri-encode']) remove(`${launchers}/${name}`);
  for (const name of ['gallery', 'template', 'wizards', 'tipoftheday', 'xpdfimport', 'xslt']) remove(`${resources}/${name}`);
  for (const name of [...nativeDesktopResources, ...(darwin ? darwinDesktopResources : [])]) remove(`${resources}/${name}`);
  remove(`${resources}/registry/xsltfilter.xcd`);
  remove(`${dirname(programDirectory).replaceAll('\\', '/')}/wizards`);
  for (const location of new Set(['program', resources])) {
    remove(`${location}/CREDITS.fodt`);
    const license = `${location}/LICENSE.html`;
    const retainedLicense = join(directory, 'licenses/LibreOffice-third-party.html');
    if (existsSync(join(directory, license)) && existsSync(retainedLicense)
      && sha256(join(directory, license)) === sha256(retainedLicense)) remove(license);
  }
  if (windows) {
    for (const name of ['wizards', 'shlxthdl', 'shell', 'soffice.com', 'unopkg.com', 'swriter.exe', 'scalc.exe', 'simpress.exe', 'sdraw.exe',
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
  const windowsLibraries = /^(?:libcrypto-3|libssl-3|reg_dlls|shlxtmsi|sellangmsi|reg4allmsdoc|qslnkmsi|sdqsmsi|instooofiltmsi|sn_tools|regactivex|so_activex|spsupp_x64|spsupp_x86|inprocserv|cli_.*|policy\.1\.0\.cli_.*)\.dll$/i;
  const services = join(directory, programResources, 'services/services.rdb');
  for (const name of readdirSync(join(directory, programDirectory)).sort()) {
    if (!excludedLibraries.test(name) && !(windows && windowsLibraries.test(name))) continue;
    assert(!existsSync(services) || !readFileSync(services, 'utf8').includes(`/${name}`),
      `Removed component remains registered: ${name}; reconfigure Core with the current component selection`);
    remove(`${programDirectory}/${name}`);
  }
  // This library's only upstream consumer is the already removed unopkg CLI.
  // Reject a future recipe that gives it a retained consumer or UNO registration.
  const unopkg = `${programDirectory}/libunopkgapp.dylib`;
  if (darwin && existsSync(join(directory, unopkg))) {
    for (const file of (existsSync(join(directory, resources)) ? files(join(directory, resources)) : []).filter(file => basename(file) === 'services.rdb'))
      assert(!readFileSync(join(directory, resources, file), 'utf8').includes('libunopkgapp.dylib'),
        `Removed component remains registered: libunopkgapp.dylib in ${file}`);
    for (const prefix of ['bin', 'program']) {
      for (const name of files(join(directory, prefix))) {
        const path = `${prefix}/${name}`;
        if (path === unopkg || header(join(directory, path)) !== 0xfeedfacf) continue;
        const commands = inspectMachO(join(directory, path)).split(/Load command \d+\n/);
        assert(commands.length > 1, `Cannot inspect Mach-O load commands in ${path}`);
        for (const command of commands.filter(command => /cmd LC_(?:LOAD_DYLIB|LOAD_WEAK_DYLIB|REEXPORT_DYLIB|LAZY_LOAD_DYLIB|LOAD_UPWARD_DYLIB)\b/.test(command))) {
          const dependency = command.match(/\n\s+name (.+) \(offset \d+\)/)?.[1];
          assert(dependency, `Cannot inspect Mach-O dependency in ${path}`);
          assert(basename(dependency) !== 'libunopkgapp.dylib', `Removed library libunopkgapp.dylib is required by ${path}`);
        }
      }
    }
    remove(unopkg);
  }
  const config = `${resources}/config`;
  if (existsSync(join(directory, config))) {
    for (const name of readdirSync(join(directory, config)).sort())
      if (/^images(?:_[a-z0-9_]+)?\.zip$/.test(name)) remove(`${config}/${name}`);
    const ui = `${config}/soffice.cfg`;
    if (existsSync(join(directory, ui))) {
      for (const file of [...nativeUiResources, ...(darwin ? darwinUiResources : [])]) remove(`${ui}/${file}`);
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
