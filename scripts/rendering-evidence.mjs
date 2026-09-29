/** Pixel requirements shared by real raster checks and release receipt validation. */
import assert from 'node:assert/strict';

/** Require visible red/blue blocks in their intended order and dark text after compositing onto white. */
export function assertRenderingPixels(metrics, label) {
  assert.ok(metrics && typeof metrics === 'object', `Missing Office rendering metrics: ${label}`);
  const { width, height, visiblePixels, redPixels, bluePixels, darkPixels, redCenterX, blueCenterX } = metrics;
  const pixels = width * height;
  const diagnostic = `${label}: ${JSON.stringify(metrics)}`;
  assert.ok([width, height, pixels].every(value => Number.isSafeInteger(value) && value > 0), `Invalid Office image dimensions; ${diagnostic}`);
  assert.ok([visiblePixels, redPixels, bluePixels, darkPixels].every(value => Number.isSafeInteger(value) && value >= 0 && value <= pixels),
    `Invalid Office image pixel counts; ${diagnostic}`);
  assert.ok(visiblePixels >= pixels * 0.04, `Office image is blank or lacks visible content; ${diagnostic}`);
  assert.ok(redPixels >= pixels * 0.01 && bluePixels >= pixels * 0.01, `Office image lacks red/blue filled areas; ${diagnostic}`);
  assert.ok(darkPixels >= pixels * 0.0002, `Office image lacks dark text; ${diagnostic}`);
  assert.ok([redCenterX, blueCenterX].every(value => Number.isFinite(value) && value >= 0 && value < width)
    && redCenterX + width * 0.1 < blueCenterX, `Office red/blue positions are reversed or displaced; ${diagnostic}`);
}

/** Reject receipts without direct Office pixel qualification for every shipped modern Office format. */
export function assertRenderingEvidence(rendering, expectedBackend) {
  assert.ok(expectedBackend === 'native' || expectedBackend === 'wasm', 'Unknown expected Office rendering backend');
  for (const extension of ['docx', 'xlsx', 'pptx']) {
    const result = rendering?.[extension];
    assert.equal(result?.backend, expectedBackend, `Missing ${expectedBackend} ${extension} rendering evidence`);
    assert.equal(result.rasterEngine, 'libreoffice', `${extension} rendering must use LibreOffice pixels`);
    assertRenderingPixels(result, `${expectedBackend} ${extension}`);
  }
}
