/** Synthetic receipts exist only in unit tests; runtime evidence comes from real installed browsers. */
import { readonlyReceiptFixture } from './readonly-receipt-fixture.mjs';
import { previewMutationProbes } from '../scripts/verify-preview-runtime.mjs';
export function previewRuntimeFixture(archiveSha256, wasmSha256, sourceCommit) {
  return { schemaVersion: 1, kind: 'preview-runtime', sourceCommit, sourceDirty: false,
    archiveSha256, wasmSha256, passed: true, installedOutsideRepository: true, npmOffline: true,
    externalNetworkRequests: 0, crossOriginIsolated: true, workerDisposal: true,
    publicMutationApiAbsent: true, fontSubsets: true, fontDemand: true,
    nativeReadonlyModel: readonlyReceiptFixture(),
    formats: Object.fromEntries(['docx', 'xlsx', 'pptx'].map(format => [format, {
      opened: true, disposed: true, bytes: 100, paintedPixels: 10, rgbaSha256: '3'.repeat(64), afterRgbaSha256: '3'.repeat(64),
      sourceSha256: '4'.repeat(64), sourceAfterSha256: '4'.repeat(64), modelUnchanged: true,
      selection: { selected: true, copied: true, characters: 3, textSha256: '5'.repeat(64), afterTextSha256: '5'.repeat(64),
        mode: format === 'pptx' ? 'whole-object-text' : 'text-range' },
      workerBoundaryVerified: true,
      rejectedOperations: Object.fromEntries(previewMutationProbes.map(probe => [probe, true])),
      ...(format === 'docx' ? { layout: { paginated: true, continuous: true, reflowed: true, sameWidthStable: true,
        viewportIndependent: true, paginatedRestored: true, widthMatched: true, selectionPreserved: true,
        wideRgbaSha256: '6'.repeat(64), narrowRgbaSha256: '7'.repeat(64),
        wide: { width: 700, height: 1000 }, narrow: { width: 360, height: 2000 } } } : {}),
      ...(format === 'xlsx' ? { worksheets: { selected: true, formulaPreserved: true, stalePartRejected: true, selectionPreservedAfterStalePart: true } } : {}),
    }])) };
}
