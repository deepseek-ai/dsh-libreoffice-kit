import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
const { zipSync } = createRequire(new URL('../packages/entry/package.json', import.meta.url))('fflate');
import { auditBytes, auditNpmArchive, privacyOptions, visitTar } from '../scripts/publication-privacy.mjs';
import { npmFixture, tarFixture } from './archive-fixture.mjs';

const options = { secrets: [], identifiers: [] };
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kit-privacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('known credentials and personal paths fail without disclosing matched values', () => {
  const secret = 'fixture-' + 'random-credential-value';
  for (const value of [Buffer.from(secret), Buffer.from(secret, 'utf16le'), Buffer.from(Buffer.from(secret).toString('base64'))]) {
    assert.throws(() => auditBytes(value, 'payload', { ...options, secrets: [secret] }), error => /known credential/.test(error.message) && !error.message.includes(secret));
  }
  for (const path of ['/Users/private-builder/code/x.cxx', '/home/private-builder/core/x.cxx', 'C:\\Users\\private-builder\\core\\x.cxx']) {
    for (const value of [Buffer.from(path), Buffer.from(path, 'utf16le'), Buffer.concat([Buffer.from([1]), Buffer.from(path, 'utf16le')])]) {
      assert.throws(() => auditBytes(value, 'engine', options), /personal home path/);
    }
  }
  assert.throws(() => auditBytes(Buffer.from('Vendor=private-builder\n'), 'versionrc', options), /vendor/);
  assert.throws(() => auditBytes(Buffer.from('build identity private-builder'), 'payload', { ...options, identifiers: ['private-builder'] }), /identity/);
  assert.doesNotThrow(() => auditBytes(Buffer.from('Vendor=DeepSeek\n'), 'versionrc', options));
});

test('binary chunk boundaries and embedded private keys are checked, format constants are allowed', () => {
  const bytes = Buffer.concat([Buffer.alloc(1024 * 1024 - 8), Buffer.from('/Users/private-builder/code/x.cxx')]);
  assert.throws(() => auditBytes(bytes, 'engine', options), /personal home path/);
  assert.doesNotThrow(() => auditBytes(Buffer.from('-----BEGIN PRIVATE KEY-----\0-----END PRIVATE KEY-----'), 'library', options));
  assert.throws(() => auditBytes(Buffer.from(`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`), 'library', options), /private key/);
  assert.doesNotThrow(() => auditBytes(Buffer.alloc(0), 'empty', options));
});

test('secrets files are parsed without executing shell content or persisting values', t => {
  const file = join(scratch(t), 'credentials');
  const secret = 'fixture-' + 'non-public-credential';
  writeFileSync(file, `export API_KEY='${secret}'\n`);
  assert.ok(privacyOptions({ LIBREOFFICE_KIT_AUDIT_SECRETS_FILE: file }).secrets.includes(secret));
  writeFileSync(file, JSON.stringify({ nested: { api_key: secret } }));
  assert.ok(privacyOptions({ LIBREOFFICE_KIT_AUDIT_SECRETS_FILE: file }).secrets.includes(secret));
});

test('npm archives reject ownership, private files, duplicate paths and internal README links', t => {
  const file = join(scratch(t), 'package.tgz');
  const manifest = { name: 'fixture', version: '1.0.0' };
  const check = (files, metadata) => { writeFileSync(file, npmFixture(manifest, files, metadata)); return auditNpmArchive(file, options); };
  assert.equal(check({ 'package/bin/worker': 'engine' }).files, 2);
  assert.throws(() => check({}, { uid: 501, uname: 'private-builder' }), /ownership/);
  assert.throws(() => check({ 'package/.npmrc': 'config' }), /private file/);
  assert.throws(() => check({ 'package/._worker': 'metadata' }), /private file/);
  assert.throws(() => check({ 'package/README.md': 'https://github.com/deepseek-harness/deepseek-harness/tree/private' }), /internal application link/);
  const entry = tarFixture({ 'package/worker': 'engine' }).subarray(0, 1024);
  assert.throws(() => visitTar(Buffer.concat([entry, entry, Buffer.alloc(1024)]), () => {}), /Duplicate/);
});

test('WASM data members are scanned with their resource identity and complete offsets', t => {
  const file = join(scratch(t), 'package.tgz');
  const data = Buffer.from('Vendor=private-builder\n');
  const metadata = { remote_package_size: data.length, files: [{ filename: '/instdir/program/versionrc', start: 0, end: data.length }] };
  const put = () => writeFileSync(file, npmFixture({ name: 'fixture', version: '1.0.0' }, {
    'package/assets/soffice.data': data, 'package/assets/soffice.data.js.metadata': JSON.stringify(metadata),
  }));
  put();
  assert.throws(() => auditNpmArchive(file, options), /vendor.*versionrc/);
  metadata.files[0].start = 1; put();
  assert.throws(() => auditNpmArchive(file, options), /resource range/);
});


test('compressed ZIP resources cannot hide paths or known credentials from the package gate', t => {
  const file = join(scratch(t), 'package.tgz');
  const secret = 'fixture-' + 'secret-inside-compressed-xml';
  const zip = Buffer.from(zipSync({ 'content.xml': Buffer.from(secret) }, { level: 9 }));
  assert.equal(zip.includes(Buffer.from(secret)), false);
  writeFileSync(file, npmFixture({ name: 'fixture', version: '1.0.0' }, { 'package/program/resource.bau': zip }));
  assert.throws(() => auditNpmArchive(file, { ...options, secrets: [secret] }), /known credential/);
  const data = Buffer.from(zipSync({ 'content.xml': Buffer.from('/Users/private-builder/work') }, { level: 9 }));
  writeFileSync(file, npmFixture({ name: 'fixture', version: '1.0.0' }, {
    'package/assets/soffice.data': data,
    'package/assets/soffice.data.js.metadata': JSON.stringify({ remote_package_size: data.length, files: [{ filename: '/instdir/resource.bau', start: 0, end: data.length }] }),
  }));
  assert.throws(() => auditNpmArchive(file, options), /personal home path/);
});


test('npm tar headers can encode anonymous ownership as empty numeric fields', () => {
  const bytes = tarFixture({ 'package/package.json': '{}' });
  bytes.fill(0, 108, 124);
  bytes.fill(32, 148, 156);
  bytes.write(bytes.subarray(0, 512).reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
  visitTar(bytes, entry => { assert.equal(entry.uid, 0); assert.equal(entry.gid, 0); });
});
