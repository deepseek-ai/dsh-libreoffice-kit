import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { requiredUiResources } from '../engine/ui-resource-policy.mjs';
import { pruneNativePayload, stripNativePayload } from '../scripts/slim-native.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'office-slim-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
  for (const part of ['bin', 'program']) mkdirSync(join(directory, part));
  const put = (file, bytes = 'fixture') => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), bytes);
  };
  return { directory, put };
}

for (const platform of ['darwin-arm64', 'linux-arm64-glibc']) test(`${platform} trims desktop assets while retaining conversion resources and notices`, t => {
  const { directory, put } = fixture(t);
  const program = platform.startsWith('darwin-') ? 'program/Office.app/Contents/Frameworks' : 'program/program';
  const resources = `${dirname(program)}/${platform.startsWith('darwin-') ? 'Resources' : 'share'}`;
  const desktop = ['gallery/picture.svg', 'template/blank.ott', 'wizards/index.py', 'tipoftheday/tips.txt', 'config/images_colibre.zip', 'config/images.zip', 'main.icns', 'intro-highres.png',
    'basic/Standard/script.xlb', 'Scripts/python/ScriptForgeHelper.py',
    'config/soffice.cfg/modules/swriter/ui/formatobjectdialog.ui', 'config/soffice.cfg/modules/schart/ui/charttypedialog.ui',
    'config/soffice.cfg/modules/swriter/ui/notebookbar.ui', 'config/soffice.cfg/modules/scalc/ui/notebookbar_compact.ui',
    'config/soffice.cfg/modules/swriter/toolbar/standardbar.xml', 'config/soffice.cfg/modules/simpress/menubar/menubar.xml'];
  const runtime = ['config/soffice.cfg/settings.xml', ...requiredUiResources.map(file => `config/soffice.cfg/${file}`),
    'registry/writer.xcd', 'filter/ooxml.xcu', 'fonts/font.ttf', 'liblangtag/language.xml', 'LICENSE', 'NOTICE'];
  const programResources = platform.startsWith('darwin-') ? resources : program;
  const presets = `${platform.startsWith('darwin-') ? resources : dirname(program)}/presets`;
  const scriptFiles = [`${presets}/basic/Standard/Module1.xba`, ...['access2base.py', 'scriptforge.py', 'scriptforge.pyi'].map(name => `${programResources}/${name}`)];
  const launcher = platform.startsWith('darwin-') ? `${dirname(program)}/MacOS/soffice` : `${program}/soffice.bin`;
  put(launcher);
  for (const name of [...desktop, ...runtime]) put(`${resources}/${name}`);
  for (const name of scriptFiles) put(name);
  put(`${program}/library`, 'library');
  const result = pruneNativePayload(directory, platform, program);
  assert.equal(result.removedBytes, (desktop.length + scriptFiles.length + 1) * 7);
  assert.equal(existsSync(join(directory, launcher)), false);
  for (const name of desktop) assert.equal(existsSync(join(directory, resources, name)), false, name);
  for (const name of scriptFiles) assert.equal(existsSync(join(directory, name)), false, name);
  for (const name of runtime) assert.equal(readFileSync(join(directory, resources, name), 'utf8'), 'fixture', name);
  assert.equal(pruneNativePayload(directory, platform, program).removedBytes, 0);
});

test('Linux rejects a disabled LDAP library that remains in its program service registry', t => {
  const { directory, put } = fixture(t);
  put('program/program/libldapbe2lo.so');
  put('program/program/services/services.rdb', '<component uri="vnd.sun.star.expand:$LO_LIB_DIR/libldapbe2lo.so"/>');
  assert.throws(() => pruneNativePayload(directory, 'linux-arm64-glibc', 'program/program'), /remains registered.*reconfigure/);
});

const windowsLibraries = ['libcrypto-3.dll', 'libssl-3.dll', 'reg_dlls.dll', 'shlxtmsi.dll', 'sellangmsi.dll', 'reg4allmsdoc.dll',
  'qslnkmsi.dll', 'sdqsmsi.dll', 'instooofiltmsi.dll', 'sn_tools.dll', 'regactivex.dll', 'so_activex.dll', 'spsupp_x64.dll', 'spsupp_x86.dll', 'inprocserv.dll',
  'cli_uno.dll', ...['basetypes', 'cppuhelper', 'oootypes', 'ure', 'uretypes'].flatMap(name => [`cli_${name}.dll`, `policy.1.0.cli_${name}.dll`])];

for (const platform of ['win32-x64', 'win32-arm64']) test(`${platform} prunes desktop integrations and unused OpenSSL while retaining helper dependencies`, t => {
  const { directory, put } = fixture(t);
  const program = 'program/program';
  const architectureFiles = files => files.filter(name => platform === 'win32-x64' || !['spsupp_x64.dll', 'spsupp_x86.dll', 'twain32shim.exe'].includes(name));
  const discarded = [
    'program/wizards/common/FileAccess.py', 'program/wizards/ui/WizardDialog.py',
    `${program}/wizards/common/FileAccess.py`, `${program}/wizards/ui/WizardDialog.py`,
    ...architectureFiles([...windowsLibraries, 'shlxthdl/shlxthdl.dll', 'shlxthdl/propertyhdl.dll', 'shlxthdl/ooofilt.dll',
      'shell/about.svg', 'shell/donate1.png', 'shell/donate2.png', 'intro.png', 'intro-highres.png',
      'soffice.exe', 'unopkg.exe', 'gengal.exe', 'unoinfo.exe', 'xpdfimport.exe',
      'soffice.com', 'unopkg.com', 'swriter.exe', 'scalc.exe', 'simpress.exe', 'sdraw.exe', 'smath.exe', 'sbase.exe', 'sweb.exe',
      'soffice_safe.exe', 'quickstart.exe', 'uno.exe', 'senddoc.exe', 'regview.exe', 'spsupp_helper.exe',
      ...['basetypes', 'cppuhelper', 'oootypes', 'ure', 'uretypes'].map(name => `cli_${name}.config`)]).map(name => `${program}/${name}`),
  ];
  const kept = ['bin/libreoffice-kit.exe', 'licenses/LICENSE', 'program/share/fonts/font.ttf', 'program/share/registry/writer.xcd',
    ...architectureFiles(['twain32shim.exe', 'gpgme-w32spawn.exe', 'scnlo.dll', 'gpgmepp.dll', 'xsec_xmlsec.dll', 'nss3.dll',
      'directx9canvaslo.dll', 'gdipluscanvaslo.dll', 'emserlo.dll', 'jumplistlo.dll', 'winaccessibility.dll', 'WinUserInfoBelo.dll', 'UAccCOM.dll',
      'mergedlo.dll', 'pdffilterlo.dll', 'pdfiumlo.dll', 'swlo.dll', 'sclo.dll', 'sdlo.dll', 'unknown.exe', 'unknown.com', 'policy.other.dll',
      ...['bootstrap', 'fundamental', 'soffice', 'version', 'louno', 'uno', 'setup', 'redirect'].map(name => `${name}.ini`)]).map(name => `${program}/${name}`),
  ];
  for (const name of [...discarded, ...kept]) put(name);
  const services = `${program}/services/services.rdb`;
  const registry = '<components><component uri="vnd.sun.star.expand:$LO_LIB_DIR/winaccessibility.dll"/></components>';
  put(services, registry);
  const result = pruneNativePayload(directory, platform, program);
  assert.equal(result.removedBytes, discarded.length * Buffer.byteLength('fixture'));
  for (const name of discarded) assert.equal(existsSync(join(directory, name)), false, name);
  for (const name of kept) assert.equal(readFileSync(join(directory, name), 'utf8'), 'fixture', name);
  assert.equal(readFileSync(join(directory, services), 'utf8'), registry);
  assert.ok(result.removed.includes('program/wizards'));
  assert.ok(result.removed.includes(`${program}/wizards`));
  assert.ok(result.removed.includes(`${program}/shlxthdl`));
  assert.ok(result.removed.includes(`${program}/shell`));
  assert.deepEqual(pruneNativePayload(directory, platform, program), { removed: [], removedBytes: 0 });
});

for (const platform of ['win32-x64', 'win32-arm64', 'darwin-arm64', 'linux-arm64-glibc']) {
  const darwin = platform.startsWith('darwin-');
  const program = darwin ? 'program/Office.app/Contents/Frameworks' : 'program/program';
  const resources = `${dirname(program)}/${darwin ? 'Resources' : 'share'}`;
  const notices = darwin ? resources : 'program';
  test(`${platform} removes XSLT registrations and resources while retaining Office filters and unique notices`, t => {
    const { directory, put } = fixture(t);
    const discarded = [`${resources}/registry/xsltfilter.xcd`, `${notices}/CREDITS.fodt`,
      ...['wordml', 'spreadsheetml', 'uof', 'docbook', 'xhtml'].map(name => `${resources}/xslt/import/${name}/filter.xsl`)];
    const kept = [`${program}/library`, 'licenses/LibreOffice-MPL-2.0.txt', 'licenses/DeepSeek-Harness-MIT.txt',
      `${resources}/registry/main.xcd`, `${resources}/registry/writer.xcd`, `${resources}/registry/calc.xcd`,
      `${resources}/registry/impress.xcd`, `${resources}/filter/ooxml.xcu`, `${resources}/filter/msword.xcu`,
      `${resources}/filter/msexcel.xcu`, `${resources}/filter/mspowerpoint.xcu`, `${resources}/filter/pdf.xcu`];
    for (const file of [...discarded, ...kept]) put(file);
    put(`${notices}/LICENSE.html`, 'installation-specific notice');
    const result = pruneNativePayload(directory, platform, program);
    assert.equal(result.removedBytes, discarded.length * Buffer.byteLength('fixture'));
    assert.ok(result.removed.includes(`${resources}/xslt`));
    assert.ok(result.removed.includes(`${resources}/registry/xsltfilter.xcd`));
    for (const file of discarded) assert.equal(existsSync(join(directory, file)), false, file);
    for (const file of kept) assert.equal(readFileSync(join(directory, file), 'utf8'), 'fixture', file);
    assert.equal(readFileSync(join(directory, notices, 'LICENSE.html'), 'utf8'), 'installation-specific notice');
    assert.deepEqual(pruneNativePayload(directory, platform, program), { removed: [], removedBytes: 0 });
  });

  test(`${platform} removes LICENSE.html only with an identical retained third-party notice`, t => {
    const { directory, put } = fixture(t);
    put(`${program}/library`);
    const license = `${notices}/LICENSE.html`;
    const retained = 'licenses/LibreOffice-third-party.html';
    put(license, 'installation notice');
    assert.deepEqual(pruneNativePayload(directory, platform, program), { removed: [], removedBytes: 0 });
    put(retained, 'different dependency notice');
    assert.deepEqual(pruneNativePayload(directory, platform, program), { removed: [], removedBytes: 0 });
    assert.equal(readFileSync(join(directory, license), 'utf8'), 'installation notice');
    put(retained, 'installation notice');
    assert.deepEqual(pruneNativePayload(directory, platform, program), {
      removed: [license], removedBytes: Buffer.byteLength('installation notice'),
    });
    assert.equal(existsSync(join(directory, license)), false);
    assert.equal(readFileSync(join(directory, retained), 'utf8'), 'installation notice');
    assert.deepEqual(pruneNativePayload(directory, platform, program), { removed: [], removedBytes: 0 });
  });
}

for (const library of windowsLibraries) test(`Windows refuses to prune registered ${library}`, t => {
  const { directory, put } = fixture(t);
  const program = 'program/program';
  put(`${program}/${library}`);
  put(`${program}/services/services.rdb`, `<component uri="vnd.sun.star.expand:$LO_LIB_DIR/${library}"/>`);
  assert.throws(() => pruneNativePayload(directory, 'win32-x64', program), /remains registered.*reconfigure/);
  assert.equal(readFileSync(join(directory, program, library), 'utf8'), 'fixture');
});

test('Windows integration pruning does not select libraries on other platforms', t => {
  const { directory, put } = fixture(t);
  for (const name of [...windowsLibraries, 'libcrypto.so.3', 'libssl.so.3', 'libcrypto.3.dylib', 'libssl.3.dylib']) put(`program/program/${name}`);
  assert.deepEqual(pruneNativePayload(directory, 'linux-x64-glibc', 'program/program'), { removed: [], removedBytes: 0 });
});

test('macOS removes a byte-identical build alias and rejects an alias with different library bytes', t => {
  const { directory, put } = fixture(t);
  const program = 'program/Office.app/Contents/Frameworks';
  const alias = 'program/Office.app/Contents/MacOS/urelibs';
  put(`${program}/lib.dylib`, 'runtime');
  put(`${alias}/lib.dylib`, 'different');
  assert.throws(() => pruneNativePayload(directory, 'darwin-x64', program), /alias differs/);
  assert.equal(existsSync(join(directory, alias)), true);
  put(`${alias}/lib.dylib`, 'runtime');
  assert.deepEqual(pruneNativePayload(directory, 'darwin-x64', program), { removed: [alias], removedBytes: 7 });
  assert.equal(readFileSync(join(directory, program, 'lib.dylib'), 'utf8'), 'runtime');
});

test('symbol cleanup retains dynamic exports, signs macOS files, and checks the resulting signature', t => {
  const { directory, put } = fixture(t);
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0xfeedfacf);
  put('bin/worker', binary); put('program/lib.dylib', binary); put('program/data', 'unchanged');
  const calls = [];
  const result = stripNativePayload(directory, 'darwin-arm64', (command, args) => {
    calls.push([command, args.slice(0, -1)]);
    if (command === 'strip') writeFileSync(args.at(-1), binary.subarray(0, 32));
  });
  assert.deepEqual(calls, Array.from({ length: 2 }, () => [
    ['strip', ['-S', '-x']], ['codesign', ['--force', '--sign', '-', '--timestamp=none']], ['codesign', ['--verify']],
  ]).flat());
  assert.deepEqual(result, { stripped: ['bin/worker', 'program/lib.dylib'], beforeBytes: 128, afterBytes: 64 });
  assert.equal(readFileSync(join(directory, 'program/data'), 'utf8'), 'unchanged');
  assert.throws(() => stripNativePayload(directory, 'darwin-arm64', () => { throw new Error('strip failed'); }), /strip failed/);
});

test('Linux strips executables and Core libraries but retains authenticated runtime and NSS check files', t => {
  const { directory, put } = fixture(t);
  const binary = Buffer.alloc(64); binary.writeUInt32LE(0x464c457f);
  for (const file of ['bin/worker', 'program/core.so', 'program/libnss3.so', 'program/libsoftokn3.so']) put(file, binary);
  put('program/libsoftokn3.chk', 'checksum');
  put('sources/linux-runtime/receipt.json', JSON.stringify({ packages: [{ files: [{ name: 'libnss3.so' }] }] }));
  const calls = [];
  const result = stripNativePayload(directory, 'linux-arm64-glibc', (command, args) => calls.push([command, args]));
  assert.deepEqual(result.stripped, ['bin/worker', 'program/core.so']);
  assert.ok(calls.every(([command, args]) => command === 'strip' && args[0] === '--strip-unneeded'));
  assert.equal(readFileSync(join(directory, 'program/libnss3.so')).length, 64);
  assert.equal(readFileSync(join(directory, 'program/libsoftokn3.so')).length, 64);
});

test('staging removes developer SDK tools while retaining runtime resources', t => {
  const { directory, put } = fixture(t);
  put('program/LibreOfficeDev26.8_SDK/bin/cppumaker', 'sdk tool');
  put('program/LibreOfficeDev.app/Contents/Frameworks/libuno.dylib', 'runtime');
  const result = pruneNativePayload(directory, 'darwin-arm64', 'program/LibreOfficeDev.app/Contents/Frameworks');
  assert.deepEqual(result.removed, ['program/LibreOfficeDev26.8_SDK']);
  assert.equal(result.removedBytes, 8);
  assert.ok(existsSync(join(directory, 'program/LibreOfficeDev.app/Contents/Frameworks/libuno.dylib')));
});

test('staging retains embedded PDF rendering while dropping desktop import and network modules', t => {
  const { directory, put } = fixture(t);
  const contents = 'program/LibreOfficeDev.app/Contents';
  const libraries = `${contents}/Frameworks`;
  const discarded = ['MacOS/xpdfimport', 'Resources/xpdfimport/poppler_data/cMap/data', 'Library/Spotlight/OOo.mdimporter/binary', 'PlugIns/QuickLook.appex/binary',
    ...['libclucene.dylib', 'libucpchelp1.dylib', 'libhelplinkerlo.dylib', 'libcurl.4.dylib', 'libucpdav1.dylib', 'libucpcmis1lo.dylib', 'libLanguageToollo.dylib', 'libpdfimportlo.dylib', 'libldapbe2lo.dylib'].map(name => `Frameworks/${name}`)];
  for (const file of discarded) put(`${contents}/${file}`);
  const kept = ['libpdfiumlo.dylib', 'libpdffilterlo.dylib', 'libswlo.dylib', 'libsclo.dylib', 'libsdlo.dylib', 'libucb1.dylib', 'libucpfile1.dylib', 'libsblo.dylib', 'libxmlscriptlo.dylib'];
  for (const name of kept) put(`${libraries}/${name}`);
  pruneNativePayload(directory, 'darwin-arm64', libraries);
  for (const file of discarded) assert.ok(!existsSync(join(directory, contents, file)), file);
  for (const name of kept) assert.ok(existsSync(join(directory, libraries, name)), name);
});

for (const library of ['libucpdav1.dylib', 'libldapbe2lo.dylib']) test(`staging refuses to prune registered ${library}`, t => {
  const { directory, put } = fixture(t);
  const contents = 'program/LibreOfficeDev.app/Contents';
  put(`${contents}/Frameworks/${library}`);
  put(`${contents}/Resources/services/services.rdb`, `<component uri="vnd.sun.star.expand:$LO_LIB_DIR/${library}"/>`);
  assert.throws(() => pruneNativePayload(directory, 'darwin-arm64', `${contents}/Frameworks`), /remains registered.*reconfigure/);
});

for (const platform of ['darwin-arm64', 'darwin-x64']) test(`${platform} drops the unopkg-only library after checking retained Mach-O consumers`, t => {
  const { directory, put } = fixture(t);
  const contents = 'program/Office.app/Contents';
  const program = `${contents}/Frameworks`;
  const unopkg = `${program}/libunopkgapp.dylib`;
  const image = Buffer.alloc(32); image.writeUInt32LE(0xfeedfacf);
  for (const file of ['bin/worker', `${program}/libretained.dylib`, `${contents}/MacOS/unopkg`, unopkg]) put(file, image);
  const inspected = [];
  const result = pruneNativePayload(directory, platform, program, file => {
    inspected.push(file);
    return `${file}:\nLoad command 0\n          cmd LC_LOAD_DYLIB\n         name @rpath/libretained.dylib (offset 24)\n`;
  });
  assert.equal(existsSync(join(directory, unopkg)), false);
  assert.equal(existsSync(join(directory, contents, 'MacOS/unopkg')), false);
  assert.equal(result.removedBytes, image.length * 2);
  assert.deepEqual(inspected, ['bin/worker', `${program}/libretained.dylib`].map(file => join(directory, file)));
  assert.deepEqual(pruneNativePayload(directory, platform, program, () => assert.fail('Already removed')), { removed: [], removedBytes: 0 });
});

for (const registry of ['services/services.rdb', 'ure/share/misc/services.rdb']) test(`unopkg pruning rejects a registration in ${registry}`, t => {
  const { directory, put } = fixture(t);
  const contents = 'program/Office.app/Contents';
  const program = `${contents}/Frameworks`;
  put(`${program}/libunopkgapp.dylib`);
  put(`${contents}/Resources/${registry}`, '<component uri="vnd.sun.star.expand:$LO_LIB_DIR/libunopkgapp.dylib"/>');
  assert.throws(() => pruneNativePayload(directory, 'darwin-arm64', program), /remains registered: libunopkgapp/);
  assert.equal(existsSync(join(directory, program, 'libunopkgapp.dylib')), true);
});

for (const command of ['LOAD_DYLIB', 'LOAD_WEAK_DYLIB', 'REEXPORT_DYLIB', 'LAZY_LOAD_DYLIB', 'LOAD_UPWARD_DYLIB'])
  test(`unopkg pruning refuses a retained LC_${command} consumer`, t => {
    const { directory, put } = fixture(t);
    const program = 'program/Office.app/Contents/Frameworks';
    const image = Buffer.alloc(32); image.writeUInt32LE(0xfeedfacf);
    put(`${program}/libunopkgapp.dylib`, image);
    put('bin/worker', image);
    assert.throws(() => pruneNativePayload(directory, 'darwin-arm64', program,
      () => `Load command 0\n          cmd LC_${command}\n         name @rpath/libunopkgapp.dylib (offset 24)\n`), /is required by bin\/worker/);
    assert.equal(existsSync(join(directory, program, 'libunopkgapp.dylib')), true);
  });

test('unopkg pruning rejects unreadable or malformed Mach-O inspection', t => {
  const { directory, put } = fixture(t);
  const program = 'program/Office.app/Contents/Frameworks';
  const image = Buffer.alloc(32); image.writeUInt32LE(0xfeedfacf);
  put(`${program}/libunopkgapp.dylib`, image);
  put('bin/worker', image);
  for (const output of ['', 'Load command 0\n cmd LC_LOAD_DYLIB\n invalid dependency\n'])
    assert.throws(() => pruneNativePayload(directory, 'darwin-arm64', program, () => output), /Cannot inspect Mach-O/);
  assert.throws(() => pruneNativePayload(directory, 'darwin-arm64', program, () => { throw new Error('otool failed'); }), /otool failed/);
  assert.equal(existsSync(join(directory, program, 'libunopkgapp.dylib')), true);
});
