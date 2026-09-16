import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pruneNativePayload } from '../scripts/slim-native.mjs';
import { darwinDesktopResources, darwinUiResources, nativeDesktopResources, nativeUiResources } from '../scripts/native-resource-policy.mjs';

test('the reviewed native resource inventory has no duplicate or overlapping exclusions', () => {
  assert.equal(nativeUiResources.length, 59);
  assert.equal(darwinUiResources.length, 5);
  assert.equal(nativeDesktopResources.length, 5);
  assert.equal(darwinDesktopResources.length, 3);
  assert.equal(new Set([...nativeUiResources, ...darwinUiResources]).size, 64);
  assert.equal(new Set([...nativeDesktopResources, ...darwinDesktopResources]).size, 8);
});

for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64-glibc', 'linux-x64-glibc', 'win32-arm64', 'win32-x64']) {
  test(`${platform} prunes reviewed resources without broadening names or crossing platform boundaries`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'office-resource-policy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 3 }));
    const darwin = platform.startsWith('darwin-');
    const program = darwin ? 'program/LibreOfficeDev.app/Contents/Frameworks' : 'program/program';
    const resources = `${dirname(program)}/${darwin ? 'Resources' : 'share'}`;
    const ui = `${resources}/config/soffice.cfg`;
    const launchers = darwin ? `${dirname(program)}/MacOS` : program;
    for (const path of ['bin', program]) mkdirSync(join(directory, path), { recursive: true });
    const contents = new Map();
    const put = path => {
      const bytes = `resource bytes for ${path}\n`;
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), bytes);
      contents.set(path, bytes);
    };

    for (const path of [...nativeUiResources, ...darwinUiResources]) put(`${ui}/${path}`);
    for (const path of [...nativeDesktopResources, ...darwinDesktopResources]) {
      if (path === 'config/wizard/form/styles' || path === 'theme_definitions/ios') {
        put(`${resources}/${path}/resource.xml`);
        put(`${resources}/${path}/nested/resource.css`);
      } else put(`${resources}/${path}`);
    }

    // Adjacent conversion data and similarly named resources must survive exact-path exclusions.
    const retained = [
      'bin/libreoffice-kit', `${program}/types.rdb`, `${program}/library`,
      ...['unknown.ui', 'formatobjectdialog.ui', 'alreadyexistsdialog-custom.ui', 'alreadyexistsdialog.ui.backup']
        .map(name => `${ui}/modules/swriter/ui/${name}`),
      `${ui}/modules/schart/ui/charttypedialog.ui`, `${ui}/modules/sabpilot/ui/abspilot.ui`,
      `${ui}/cui/ui/querydialog.ui`, `${ui}/cui/ui/combobox.ui`,
      `${ui}/custom/ui/alreadyexistsdialog.ui`, `${ui}/custom/ui/printerpropertiesdialog.ui`,
      ...[
        'config/soffice.cfg/settings.xml', 'config/wizard/form/stylesheets/retained.css',
        'palette/standard.soc', 'fonts/font.ttf', 'liblangtag/language.xml',
        'theme_definitions/default/theme.xml', 'theme_definitions/ios-extra/theme.xml',
        'registry/main.xcd', 'registry/writer.xcd', 'registry/lang.xcd', 'filter/ooxml.xcu',
        'registry/oo-ldap.xcd', 'registry/oo-ldap.xcd.sample.extra',
        'glade/libreoffice-catalog.xml.backup', 'skia/skia_denylist_metal.xml',
        'skia/skia_denylist_vulkan.xml.backup', 'senddoc-helper', 'unoinfo-extra',
      ].map(path => `${resources}/${path}`),
      ...['uno', 'regviewer', 'uri-encode-extra'].map(name => `${launchers}/${name}`),
    ];
    for (const path of retained) put(path);
    for (const name of ['regview', 'uri-encode']) put(`${launchers}/${name}`);

    const result = pruneNativePayload(directory, platform, program);
    for (const path of nativeUiResources) assert.equal(existsSync(join(directory, ui, path)), false, path);
    for (const path of nativeDesktopResources) assert.equal(existsSync(join(directory, resources, path)), false, path);
    for (const path of darwinUiResources) assert.equal(existsSync(join(directory, ui, path)), !darwin, `${platform}: ${path}`);
    for (const path of darwinDesktopResources) assert.equal(existsSync(join(directory, resources, path)), !darwin, `${platform}: ${path}`);
    for (const name of ['regview', 'uri-encode'])
      assert.equal(existsSync(join(directory, launchers, name)), !darwin, `${platform}: ${name}`);
    for (const path of retained) assert.equal(readFileSync(join(directory, path), 'utf8'), contents.get(path), path);
    if (!darwin) {
      for (const path of [...darwinUiResources.map(name => `${ui}/${name}`), ...darwinDesktopResources.map(name => `${resources}/${name}`),
        `${launchers}/regview`, `${launchers}/uri-encode`])
        assert.equal(readFileSync(join(directory, path), 'utf8'), contents.get(path), `${platform}: ${path}`);
    }

    const removedFiles = [...contents].filter(([path]) => !existsSync(join(directory, path)));
    assert.equal(result.removedBytes, removedFiles.reduce((bytes, [, value]) => bytes + Buffer.byteLength(value), 0));
    assert.deepEqual(pruneNativePayload(directory, platform, program), { removed: [], removedBytes: 0 });
  });
}
