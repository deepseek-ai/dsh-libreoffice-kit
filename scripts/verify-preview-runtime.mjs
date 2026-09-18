/** Authenticate the installed reading runtime's evidence against the final two archives. */
import { assert } from './verify-artifacts.mjs';

export const previewMutationProbes = ['key-input', 'ime-input', 'paste', 'command', 'save', 'legacy-edit', 'legacy-capture', 'invalid-navigation'];
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;

/** Old editor receipts cannot qualify the read-only SDK or its Writer layout ABI. */
export function verifyPreviewRuntime(receipt, { sourceCommit, kitSha256, wasmSha256, allowDirty = false }) {
  assert(receipt?.schemaVersion === 1 && receipt.kind === 'preview-runtime', 'Unsupported preview runtime receipt version');
  assert(receipt.sourceCommit === sourceCommit && /^[a-f0-9]{40}$/.test(sourceCommit), 'Preview runtime belongs to a different source commit');
  assert(hash(kitSha256) && hash(wasmSha256) && receipt.archiveSha256 === kitSha256 && receipt.wasmSha256 === wasmSha256,
    'Preview runtime belongs to different main or WASM bytes');
  assert(typeof receipt.sourceDirty === 'boolean' && (allowDirty || receipt.sourceDirty === false), 'Preview runtime requires clean source');
  assert(receipt.passed === true && receipt.installedOutsideRepository === true && receipt.npmOffline === true
    && receipt.externalNetworkRequests === 0 && receipt.crossOriginIsolated === true && receipt.workerDisposal === true
    && receipt.fontSubsets === true && receipt.fontDemand === true && receipt.publicMutationApiAbsent === true,
  'Missing isolated installed preview runtime evidence');
  for (const format of ['docx', 'xlsx', 'pptx']) {
    const result = receipt.formats?.[format];
    assert(result?.opened === true && result.disposed === true && positive(result.bytes)
      && positive(result.paintedPixels) && hash(result.rgbaSha256) && hash(result.sourceSha256)
      && result.rgbaSha256 === result.afterRgbaSha256 && result.sourceSha256 === result.sourceAfterSha256 && result.modelUnchanged === true,
    `Missing source-preserving preview evidence: ${format}`);
    assert(result.selection?.selected === true && result.selection.copied === true
      && positive(result.selection.characters) && hash(result.selection.textSha256)
      && result.selection.textSha256 === result.selection.afterTextSha256
      && result.selection.mode === (format === 'pptx' ? 'whole-object-text' : 'text-range'), `Missing selection/copy evidence: ${format}`);
    assert(result.workerBoundaryVerified === true && previewMutationProbes.every(probe => result.rejectedOperations?.[probe] === true),
      `Missing read-only rejection evidence: ${format}`);
  }
  const layout = receipt.formats.docx.layout;
  assert(layout?.paginated === true && layout.continuous === true && layout.reflowed === true
    && layout.sameWidthStable === true && layout.viewportIndependent === true && layout.paginatedRestored === true
    && layout.widthMatched === true && layout.selectionPreserved === true
    && positive(layout.wide?.width) && positive(layout.wide?.height) && positive(layout.narrow?.width) && positive(layout.narrow?.height)
    && Math.abs(layout.wide.width - 700) <= 1 && Math.abs(layout.narrow.width - 360) <= 1
    && layout.narrow.width < layout.wide.width && layout.narrow.height > layout.wide.height
    && hash(layout.wideRgbaSha256) && hash(layout.narrowRgbaSha256) && layout.wideRgbaSha256 !== layout.narrowRgbaSha256,
  'Missing Writer continuous-layout evidence');
  assert(receipt.formats.xlsx.worksheets?.selected === true && receipt.formats.xlsx.worksheets.formulaPreserved === true
    && receipt.formats.xlsx.worksheets.crossPartSelectionPreserved === true,
    'Missing worksheet navigation evidence');
  return receipt;
}
