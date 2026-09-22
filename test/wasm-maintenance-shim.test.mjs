import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../engine/wasm-source/lok.cxx', import.meta.url), 'utf8');
const exportsPatch = readFileSync(new URL('../engine/wasm-source/patches/0003-node-runtime.patch', import.meta.url), 'utf8');

test('maintenance WASM shim excludes browser-only reading Core ABI', () => {
  for (const symbol of [
    'dsh_lok_configure_view_core',
    'dsh_lok_capture_reading_selection_core',
    'dsh_lok_restore_reading_text_selection_core',
    'dsh_lok_restore_reading_object_selection_core',
  ]) assert.ok(!source.includes(symbol), `Maintenance WASM unexpectedly references ${symbol}`);
  for (const symbol of [
    '_dsh_lok_document_configure_view',
    '_dsh_lok_document_capture_reading_selection',
    '_dsh_lok_document_restore_reading_text_selection',
    '_dsh_lok_document_restore_reading_object_selection',
  ]) assert.ok(!exportsPatch.includes(symbol), `Maintenance WASM unexpectedly exports ${symbol}`);
  for (const symbol of ['dsh_lok_document_export', 'dsh_pdf_open', 'dsh_pdf_paint'])
    assert.ok(source.includes(symbol), `Maintenance WASM lost required export ${symbol}`);
});
