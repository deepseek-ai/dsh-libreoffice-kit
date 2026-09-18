/** Bind successful browser rendering and font-subset qualification to the exact distributed archives. */
import { assert } from './verify-artifacts.mjs';

/** Require all supported formats, isolation, font subsets and joined Worker disposal. */
export function verifyBrowserReceipt(receipt, { browserSha256, adapterSha256, fontsSha256, wasmSha256, sourceCommit, allowDirty = false }) {
  assert(receipt?.sourceCommit === sourceCommit && /^[a-f0-9]{40}$/.test(sourceCommit), 'Browser verification belongs to a different source commit');
  if (wasmSha256 !== undefined) {
    assert(receipt?.archiveSha256 === browserSha256 && receipt?.wasmSha256 === wasmSha256,
      'Browser verification belongs to different main or WASM bytes');
  } else {
    assert((adapterSha256 === undefined) !== (fontsSha256 === undefined), 'Browser verification requires one Host font archive');
    assert(receipt?.archiveSha256 === browserSha256 && (fontsSha256 === undefined ? receipt?.adapterSha256 === adapterSha256 : receipt?.fontsSha256 === fontsSha256),
      'Browser verification belongs to different browser or adapter bytes');
  }
  assert(typeof receipt?.sourceDirty === 'boolean' && (allowDirty || receipt.sourceDirty === false), 'Browser verification requires a clean source checkout');
  assert(receipt?.passed === true && receipt?.isolated === true && receipt?.fontSubsets === true && receipt?.disposed === true,
    'Missing browser isolation, font subset or disposal evidence');
  for (const format of ['doc', 'docx', 'ppt', 'pptx']) {
    const result = receipt.formats?.[format];
    assert(Number.isSafeInteger(result?.pages) && result.pages > 0 && Number.isSafeInteger(result?.paintedPixels) && result.paintedPixels > 0,
      `Missing browser rendering evidence: ${format}`);
  }
  return receipt;
}
