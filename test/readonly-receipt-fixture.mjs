/** Synthetic native-model receipts for publication unit tests. */
import { readonlyCases } from '../scripts/verify-readonly-model.mjs';
export function readonlyReceiptFixture() {
  return { schemaVersion: 1, kind: 'native-readonly-model', passed: true,
    cases: readonlyCases.map(parts => ({ id: parts.join('/'), modelUnchanged: true, undoUnchanged: true, changedPixels: 0 })) };
}
