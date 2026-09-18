/** Synthetic browser qualification of the existing main and WASM archives. */
export function browserReceiptFixture(adapterSha256, wasmSha256, sourceCommit) {
  return { sourceCommit, sourceDirty: false, archiveSha256: adapterSha256, wasmSha256, passed: true, isolated: true, fontSubsets: true, disposed: true,
    formats: Object.fromEntries(['doc', 'docx', 'ppt', 'pptx'].map(format => [format, { pages: 1, paintedPixels: 100 }])) };
}
