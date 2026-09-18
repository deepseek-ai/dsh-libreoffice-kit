#!/usr/bin/env node
/** Verify the independent browser/font candidate and optional exact-archive rendering receipt. */
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isMain, readJson, tarballName } from './platform-matrix.mjs';
import { assert, sha256 } from './verify-artifacts.mjs';
import { verifyBrowserReceipt } from './verify-browser-receipt.mjs';
import { verifyPreviewRuntime } from './verify-preview-runtime.mjs';

/** This development candidate never requires native-engine archives or conversion receipts. */
export function verifyBrowserPreview(directory, receipt) {
  const candidate = readJson(join(directory, 'browser-preview.json'));
  assert(candidate.schemaVersion === 1 && candidate.kind === 'browser-preview', 'Invalid browser preview candidate');
  assert(/^[a-f0-9]{40}$/.test(candidate.sourceCommit) && typeof candidate.sourceDirty === 'boolean', 'Missing preview source identity');
  assert(JSON.stringify(Object.keys(candidate.packages ?? {}).sort()) === '["kit","wasm"]', 'Preview requires only the existing main and WASM packages');
  for (const [kind, record] of Object.entries(candidate.packages)) {
    assert(record.name === (kind === 'kit' ? '@deepseek-ai/libreoffice-kit' : '@deepseek-ai/libreoffice-kit-wasm') && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(record.version)
      && record.file === tarballName(record), 'Noncanonical preview package');
    assert(Number.isSafeInteger(record.bytes) && record.bytes > 0 && statSync(join(directory, record.file)).size === record.bytes
      && /^[a-f0-9]{64}$/.test(record.sha256) && sha256(join(directory, record.file)) === record.sha256, `Preview archive checksum differs: ${kind}`);
  }
  assert(candidate.packages.kit.version === candidate.packages.wasm.version, 'Main and WASM versions differ');
  assert(Array.isArray(candidate.dependencies), 'Missing runtime dependency closure');
  const names = new Set();
  for (const record of candidate.dependencies) {
    assert(typeof record.name === 'string' && /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(record.name)
      && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(record.version) && !record.name.startsWith('@deepseek-ai/libreoffice-kit') && !names.has(record.name)
      && record.file === `dependencies/${tarballName(record)}`, 'Invalid preview dependency');
    names.add(record.name);
    assert(/^[a-f0-9]{64}$/.test(record.sha256) && sha256(join(directory, record.file)) === record.sha256, 'Preview dependency checksum differs');
  }
  if (receipt !== undefined) {
    assert(receipt.sourceDirty === candidate.sourceDirty, 'Preview receipt source state differs');
    if (receipt.kind === 'preview-runtime') verifyPreviewRuntime(receipt, { sourceCommit: candidate.sourceCommit,
      kitSha256: candidate.packages.kit.sha256, wasmSha256: candidate.packages.wasm.sha256, allowDirty: true });
    else verifyBrowserReceipt(receipt, { browserSha256: candidate.packages.kit.sha256, wasmSha256: candidate.packages.wasm.sha256,
      sourceCommit: candidate.sourceCommit, allowDirty: true });
  }
  return candidate;
}

if (isMain(import.meta.url)) {
  assert(process.argv[2], 'Usage: verify-browser-preview.mjs <candidate-directory> [browser-receipt.json]');
  console.log(JSON.stringify(verifyBrowserPreview(resolve(process.argv[2]), process.argv[3] ? readJson(resolve(process.argv[3])) : undefined), null, 2));
}
