import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPreviewRuntime, previewMutationProbes } from '../scripts/verify-preview-runtime.mjs';
import { previewRuntimeFixture } from './preview-runtime-fixture.mjs';
const identity = { kitSha256: '1'.repeat(64), wasmSha256: '2'.repeat(64), sourceCommit: '3'.repeat(40) };
const fixture = () => previewRuntimeFixture(identity.kitSha256, identity.wasmSha256, identity.sourceCommit);
test('preview qualification binds reading evidence to both final archives and clean source', () => {
  const receipt = fixture(); assert.equal(verifyPreviewRuntime(receipt, identity), receipt);
  receipt.sourceDirty = true;
  assert.throws(() => verifyPreviewRuntime(receipt, identity), /clean source/);
  assert.equal(verifyPreviewRuntime(receipt, { ...identity, allowDirty: true }), receipt);
});
test('old editing receipts and incomplete reading/runtime evidence cannot qualify publication', () => {
  for (const mutate of [
    r => r.kind = 'browser-editor', r => r.schemaVersion = 2, r => r.sourceCommit = '4'.repeat(40),
    r => r.archiveSha256 = '4'.repeat(64), r => r.wasmSha256 = '4'.repeat(64), r => r.passed = false,
    r => r.publicMutationApiAbsent = false, r => r.externalNetworkRequests = 1, r => r.fontDemand = false,
    r => r.formats.docx.sourceAfterSha256 = '0'.repeat(64), r => r.formats.pptx.modelUnchanged = false,
    r => r.formats.docx.afterRgbaSha256 = '0'.repeat(64), r => delete r.formats.pptx.afterRgbaSha256,
    r => r.formats.xlsx.selection.afterTextSha256 = '0'.repeat(64), r => delete r.formats.docx.selection.afterTextSha256,
    r => r.formats.pptx.selection.mode = 'text-range', r => r.formats.docx.workerBoundaryVerified = false,
    r => r.formats.pptx.selection.characters = 0, r => r.formats.xlsx.selection.copied = false,
    r => r.formats.docx.layout.sameWidthStable = false, r => r.formats.docx.layout.viewportIndependent = false,
    r => r.formats.docx.layout.narrow.height = r.formats.docx.layout.wide.height,
    r => r.formats.docx.layout.narrow.width = r.formats.docx.layout.wide.width,
    r => r.formats.docx.layout.narrow.width = 398, r => r.formats.docx.layout.widthMatched = false,
    r => r.formats.docx.layout.selectionPreserved = false,
    r => r.formats.docx.layout.narrowRgbaSha256 = r.formats.docx.layout.wideRgbaSha256,
    r => r.formats.docx.layout.paginatedRestored = false, r => r.formats.xlsx.worksheets.formulaPreserved = false,
    r => r.formats.xlsx.worksheets.stalePartRejected = false, r => r.formats.xlsx.worksheets.selectionPreservedAfterStalePart = false,
    ...previewMutationProbes.map(probe => r => r.formats.docx.rejectedOperations[probe] = false),
  ]) { const receipt = fixture(); mutate(receipt); assert.throws(() => verifyPreviewRuntime(receipt, identity)); }
});
test('malformed JSON receipt shapes and coerced values cannot stand in for qualification evidence', () => {
  for (const value of [null, [], '', 0, false, {}, { kind: 'preview-runtime', schemaVersion: 1 }]) {
    assert.throws(() => verifyPreviewRuntime(value, identity));
  }
  for (const path of [
    ['formats'], ['formats', 'docx'], ['formats', 'xlsx', 'selection'],
    ['formats', 'pptx', 'rejectedOperations'], ['formats', 'docx', 'layout'],
    ['formats', 'docx', 'layout', 'wide'], ['formats', 'docx', 'layout', 'narrow'], ['formats', 'xlsx', 'worksheets'],
  ]) {
    for (const value of [null, [], '', 0, false, {}]) {
      const receipt = fixture();
      const parent = path.slice(0, -1).reduce((object, key) => object[key], receipt);
      parent[path.at(-1)] = value;
      assert.throws(() => verifyPreviewRuntime(receipt, identity), `${path.join('.')} accepted ${JSON.stringify(value)}`);
    }
  }
  for (const mutate of [
    r => r.passed = 'true', r => r.workerDisposal = 1, r => r.externalNetworkRequests = '0', r => delete r.sourceDirty,
    r => r.formats.docx.bytes = '100', r => r.formats.docx.bytes = -1,
    r => r.formats.docx.paintedPixels = 0.5, r => r.formats.docx.rgbaSha256 = 'a'.repeat(63),
    r => r.formats.xlsx.selection.characters = '3', r => r.formats.xlsx.selection.textSha256 = true,
    r => r.formats.pptx.rejectedOperations.paste = 'true', r => r.formats.docx.layout.wide.width = '700',
  ]) { const receipt = fixture(); mutate(receipt); assert.throws(() => verifyPreviewRuntime(receipt, identity)); }
});
