import assert from 'node:assert/strict';
import test from 'node:test';
import { requiredUiResources } from '../engine/ui-resource-policy.mjs';
import { slimWasmData } from '../engine/wasm-source/slim.mjs';

function fixture(paths) {
  const chunks = paths.map((filename, index) => Buffer.from(`${index}:${filename}\n`));
  let offset = 0;
  const files = paths.map((filename, index) => {
    const start = offset;
    offset += chunks[index].length;
    return { filename, start, end: offset, mode: 0o444 };
  });
  return { data: Buffer.concat(chunks), metadata: { files, remote_package_size: offset } };
}

test('WASM repacking preserves editor layouts outside the conversion allowlist and removes desktop chrome', () => {
  const desktop = [
    '/instdir/share/autocorr/acor_en-US.dat', '/instdir/share/autotext/en-US/standard.bau',
    '/instdir/share/wordbook/en-US.dic', '/instdir/share/palette/standard.sob',
    '/instdir/share/gallery/texture.png', '/instdir/share/template/default.ott',
    '/instdir/share/wizards/example.xba', '/instdir/share/tipoftheday/example.png',
    '/instdir/share/shell/logo.png',
    '/instdir/share/config/soffice.cfg/sfx/ui/startcenter.ui',
    '/instdir/share/config/soffice.cfg/cui/ui/tipofthedaydialog.ui',
    '/android/default-document/example.odt', '/android/default-document/example_test.ods',
    '/core/android/default-document/example.odt', '/core/android/default-document/example_test.ods',
    '/instdir/share/config/soffice.cfg/modules/swriter/ui/notebookbar.ui',
    '/instdir/share/config/soffice.cfg/modules/scalc/ui/notebookbar_compact.ui',
    '/instdir/share/config/soffice.cfg/modules/swriter/toolbar/standardbar.xml',
    '/instdir/share/config/soffice.cfg/modules/simpress/menubar/menubar.xml',
    '/instdir/share/config/images_colibre.zip', '/instdir/share/config/images.zip',
    '/instdir/program/intro.png', '/instdir/program/intro-highres.png', '/instdir/program/shell/logo.svg',
  ];
  const retained = [
    '/instdir/share/config/soffice.cfg/modules/schart/ui/charttypedialog.ui',
    '/instdir/share/config/soffice.cfg/modules/swriter/ui/formatobjectdialog.ui',
    '/instdir/share/config/soffice.cfg/modules/simpress/ui/pmintropage.ui',
    '/instdir/share/config/soffice.cfg/custom/ui/inputbar.ui',
    '/instdir/program/services/services.rdb', '/instdir/program/types.rdb',
    ...requiredUiResources.map(file => `/instdir/share/config/soffice.cfg/${file}`),
    '/instdir/share/config/soffice.cfg/settings.xml', '/instdir/share/elsewhere/keep.ui',
    '/instdir/share/registry/main.xcd', '/instdir/share/registry/writer.xcd',
    '/instdir/share/palette/standard.soc', '/instdir/share/palette/standard.sog',
    '/instdir/share/fonts/font.ttf', '/instdir/share/liblangtag/language.xml',
    '/instdir/LICENSE', '/instdir/NOTICE',
  ];
  const { data, metadata } = fixture(Array.from({ length: Math.max(desktop.length, retained.length) }, (_, index) =>
    [desktop[index], retained[index]].filter(Boolean)).flat());
  const original = structuredClone(metadata);
  const result = slimWasmData(data, metadata);
  assert.deepEqual(metadata, original);
  assert.deepEqual(result.removed.map(file => file.filename), desktop);
  assert.deepEqual(result.metadata.files.map(file => file.filename), retained);
  assert.equal(result.removedBytes, result.removed.reduce((sum, file) => sum + file.bytes, 0));
  assert.equal(result.data.length, data.length - result.removedBytes);
  assert.equal(result.metadata.remote_package_size, result.data.length);
  let end = 0;
  for (const file of result.metadata.files) {
    const prior = original.files.find(entry => entry.filename === file.filename);
    assert.deepEqual(result.data.subarray(file.start, file.end), data.subarray(prior.start, prior.end));
    assert.equal(file.mode, prior.mode);
    assert.equal(file.start, end);
    end = file.end;
  }
  assert.equal(end, result.data.length);
  assert.deepEqual(slimWasmData(data, metadata), result);
  const repeated = slimWasmData(result.data, result.metadata);
  assert.deepEqual(repeated.data, result.data);
  assert.deepEqual(repeated.metadata, result.metadata);
  assert.deepEqual(repeated.removed, []);
});

test('WASM repacking refuses invalid ranges, missing bytes and ambiguous resource paths', () => {
  for (const change of [
    ({ metadata }) => metadata.remote_package_size++,
    ({ metadata }) => metadata.files[1].start++,
    ({ metadata }) => metadata.files[1].start--,
    ({ metadata }) => metadata.files[0].end = -1,
    ({ metadata }) => metadata.files[1].end++,
    ({ metadata }) => metadata.files[1].end--,
    ({ metadata }) => metadata.files[0].start = 0.5,
    ({ metadata }) => metadata.files[1].filename = metadata.files[0].filename,
    ({ metadata }) => metadata.files[0].filename = '/instdir/../escaped',
    ({ metadata }) => metadata.files[0].filename = '/instdir//empty',
    ({ metadata }) => metadata.files[0].filename = '/instdir/./dot',
    ({ metadata }) => metadata.files[0].filename = '/instdir/\\backslash',
    ({ metadata }) => metadata.files[0].filename = '/instdir/\0nul',
    ({ metadata }) => metadata.files[0].filename = 'relative',
    ({ metadata }) => metadata.files[0] = null,
  ]) {
    const original = fixture(['/instdir/program/types.rdb', '/instdir/LICENSE']);
    change(original);
    assert.throws(() => slimWasmData(original.data, original.metadata), /WASM/);
  }
  assert.throws(() => slimWasmData(Buffer.from('data'), null), /metadata/);
  const discarded = fixture(['/android/default-document/example.odt']);
  assert.throws(() => slimWasmData(discarded.data, discarded.metadata), /Missing required headless UI resource/);
});

test('WASM packaging rejects every missing mandatory shell before repacking', () => {
  for (const missing of requiredUiResources) {
    const { data, metadata } = fixture(requiredUiResources.filter(file => file !== missing)
      .map(file => `/instdir/share/config/soffice.cfg/${file}`));
    assert.throws(() => slimWasmData(data, metadata), error => error.message.includes(missing));
  }
});
