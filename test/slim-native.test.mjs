import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
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
    'config/soffice.cfg/modules/swriter/ui/notebookbar.ui', 'config/soffice.cfg/modules/scalc/ui/notebookbar_compact.ui',
    'config/soffice.cfg/modules/swriter/toolbar/standardbar.xml', 'config/soffice.cfg/modules/simpress/menubar/menubar.xml'];
  const runtime = ['config/soffice.cfg/settings.xml', 'config/soffice.cfg/modules/swriter/ui/formatobjectdialog.ui', 'config/soffice.cfg/modules/schart/ui/charttypedialog.ui',
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
