import test from 'node:test';
import assert from 'node:assert/strict';
import { configureFlags, verifyConfigureInput } from '../engine/native/configure.mjs';

test('native compiler caching is explicit and preserves the accepted component recipe', () => {
  for (const platform of ['darwin-arm64', 'linux-x64-glibc', 'win32-x64']) {
    const ordinary = configureFlags(platform, '/downloads', '2');
    const cached = configureFlags(platform, '/downloads', '8', '2022', false, 'ccache');
    assert.ok(ordinary.includes('--disable-ccache'));
    assert.ok(cached.includes('--enable-ccache'));
    assert.doesNotThrow(() => verifyConfigureInput(platform, cached));
    assert.throws(() => verifyConfigureInput(platform, [...cached, '--disable-ccache']), /differs/);
    assert.throws(() => verifyConfigureInput(platform, cached.filter(flag => flag !== '--enable-pdfium')), /differs/);
    assert.throws(() => verifyConfigureInput(platform, cached.map(flag => flag === '--enable-ccache' ? '--enable-ccache=nodepend' : flag)), /differs/);
  }
  assert.throws(() => configureFlags('darwin-arm64', '', '2', '2022', false, 'unknown'), /Compiler cache/);
});
