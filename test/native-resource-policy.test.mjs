import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pruneNativePayload } from '../scripts/slim-native.mjs';
import { darwinDesktopResources, nativeDesktopResources } from '../scripts/native-resource-policy.mjs';

import { requiredUiResources, assertUiCoreRevision, assertRequiredUiResources } from '../engine/ui-resource-policy.mjs';
import { readCoreSource } from '../engine/core-source.mjs';

test('the reviewed native resource inventory has no duplicate or overlapping exclusions', () => {
  assert.equal(requiredUiResources.length, 6);
  assert.equal(new Set(requiredUiResources).size, 6);
  assert.equal(nativeDesktopResources.length, 5);
  assert.equal(darwinDesktopResources.length, 3);
  assert.equal(new Set([...nativeDesktopResources, ...darwinDesktopResources]).size, 8);
});

for (const platform of ['darwin-arm64', 'darwin-x64', 'linux-arm64-glibc', 'linux-x64-glibc', 'win32-arm64', 'win32-x64']) {
  test(`${platform} prunes unlisted UI layouts and preserves platform-specific desktop rules`, t => {
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

    const excludedUi = ['modules/swriter/ui/unknown.ui', 'modules/scalc/ui/unused.ui',
      'custom/ui/inputbar.ui', 'modules/simpress/ui/tabbuttons.ui', 'svt/ui/new-dialog.ui'];
    for (const path of excludedUi) put(`${ui}/${path}`);
    for (const path of [...nativeDesktopResources, ...darwinDesktopResources]) {
      if (path === 'config/wizard/form/styles' || path === 'theme_definitions/ios') {
        put(`${resources}/${path}/resource.xml`);
        put(`${resources}/${path}/nested/resource.css`);
      } else put(`${resources}/${path}`);
    }

    // Adjacent conversion data and similarly named resources must survive exact-path exclusions.
    const retained = [
      'bin/libreoffice-kit', `${program}/types.rdb`, `${program}/library`,
      ...requiredUiResources.map(path => `${ui}/${path}`),
      `${ui}/modules/swriter/ui/dialog.ui.backup`,
      `${resources}/elsewhere/keep.ui`,
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
    for (const path of excludedUi) assert.equal(existsSync(join(directory, ui, path)), false, path);
    for (const path of nativeDesktopResources) assert.equal(existsSync(join(directory, resources, path)), false, path);
    for (const path of darwinDesktopResources) assert.equal(existsSync(join(directory, resources, path)), !darwin, `${platform}: ${path}`);
    for (const name of ['regview', 'uri-encode'])
      assert.equal(existsSync(join(directory, launchers, name)), !darwin, `${platform}: ${name}`);
    for (const path of retained) assert.equal(readFileSync(join(directory, path), 'utf8'), contents.get(path), path);
    if (!darwin) {
      for (const path of [...darwinDesktopResources.map(name => `${resources}/${name}`),
        `${launchers}/regview`, `${launchers}/uri-encode`])
        assert.equal(readFileSync(join(directory, path), 'utf8'), contents.get(path), `${platform}: ${path}`);
    }

    const removedFiles = [...contents].filter(([path]) => !existsSync(join(directory, path)));
    assert.equal(result.removedBytes, removedFiles.reduce((bytes, [, value]) => bytes + Buffer.byteLength(value), 0));
    assert.deepEqual(pruneNativePayload(directory, platform, program), { removed: [], removedBytes: 0 });
  });
}

test('UI policy requires requalification after a Core upgrade and all required layouts', () => {
  assertUiCoreRevision(readCoreSource().revision);
  assert.throws(() => assertUiCoreRevision('0'.repeat(40)), /rerun.*minimize-ui/);
  assertRequiredUiResources(requiredUiResources);
  for (const missing of requiredUiResources)
    assert.throws(() => assertRequiredUiResources(requiredUiResources.filter(file => file !== missing)),
      error => error.message.includes(missing));
});

test('native pruning refuses a missing shell before deleting any UI layouts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'office-missing-ui-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'program/program'), { recursive: true });
  const ui = join(directory, 'program/share/config/soffice.cfg');
  for (const name of [...requiredUiResources, 'modules/scalc/ui/unused.ui']) {
    mkdirSync(dirname(join(ui, name)), { recursive: true });
    writeFileSync(join(ui, name), 'layout');
  }
  rmSync(join(ui, requiredUiResources[0]));
  assert.throws(() => pruneNativePayload(directory, 'linux-x64-glibc', 'program/program'), /Missing required headless UI/);
  assert.equal(readFileSync(join(ui, 'modules/scalc/ui/unused.ui'), 'utf8'), 'layout');
  for (const name of requiredUiResources.slice(1)) assert.equal(readFileSync(join(ui, name), 'utf8'), 'layout');
});
