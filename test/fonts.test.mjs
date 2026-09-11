import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { indexSystemFonts, systemFontDirectories, SystemFontCatalog, readFont } from '../packages/entry/src/fonts.js';
import { createFontLoader } from '../packages/entry/src/font-loader.js';
import { resolveOptions } from '../packages/entry/src/options.js';

test('font directory defaults honor host platform paths', () => {
  assert.deepEqual(systemFontDirectories('win32', 'C:\\Users\\example', { SystemRoot: 'D:\\Windows', LOCALAPPDATA: 'D:\\Local' }), ['D:\\Windows\\Fonts', 'D:\\Local\\Microsoft\\Windows\\Fonts']);
  assert.deepEqual(systemFontDirectories('linux', '/home/example', { XDG_DATA_DIRS: '/usr/share:/opt/share', XDG_DATA_HOME: '/data' }), ['/usr/share/fonts', '/opt/share/fonts', '/home/example/.fonts', '/data/fonts']);
});

test('font imports retain original bytes, enforce budgets, and reject stale snapshots', t => {
  const available = indexSystemFonts({ directories: systemFontDirectories(), maxFiles: 20_000, maxFileBytes: 256 * 1024 * 1024 });
  if (!available.length) { t.skip('This host has no fontkit-readable system fonts.'); return; }
  const source = available.find(face => /Arial|Liberation Sans|DejaVu Sans/.test(face.family)) ?? available[0];
  const root = mkdtempSync(join(tmpdir(), 'libreoffice-font-test-'));
  try {
    const path = join(root, `original${extname(source.path)}`);
    copyFileSync(source.path, path);
    const faces = indexSystemFonts({ directories: [root], maxFiles: 1, maxFileBytes: source.size });
    assert.ok(faces.length > 0);
    const options = resolveOptions({ fontDirectories: [root], maxLoadedFontBytes: source.size });
    const document = { families: new Map([['unavailabletestfont', 'Unavailable Test Font']]), codePoints: [] };
    let installs = 0;
    const loader = createFontLoader(options, document, (name, bytes) => { installs++; assert.deepEqual(bytes, readFont(faces[0])); return name; }, faces);
    const request = { family: faces[0].family, style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] };
    assert.deepEqual(loader.resolve(request), loader.resolve(request));
    assert.equal(installs, 1);
    loader.resolve({ ...request, family: 'Unavailable Test Font' });
    assert.deepEqual(loader.missingFonts, ['Unavailable Test Font']);
    const bounded = createFontLoader({ ...options, maxLoadedFontBytes: source.size - 1 }, document, () => { throw new Error('Import must not start'); }, faces);
    assert.throws(() => bounded.resolve(request), /maxLoadedFontBytes/);
    assert.deepEqual(indexSystemFonts({ directories: [root], maxFiles: 1, maxFileBytes: source.size - 1 }), []);
    copyFileSync(source.path, join(root, `second${extname(source.path)}`));
    assert.throws(() => indexSystemFonts({ directories: [root], maxFiles: 1, maxFileBytes: source.size }), /maxFontFiles/);
    const catalog = new SystemFontCatalog({ faces, fallbackFamilies: [] });
    writeFileSync(path, 'changed');
    assert.throws(() => readFont(faces[0]), /changed/);
    assert.throws(() => catalog.match({ ...request, codePoints: [65] }, new AbortController().signal), /changed/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
