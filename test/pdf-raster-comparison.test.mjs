import assert from 'node:assert/strict';
import test from 'node:test';
import { comparePdfRasters } from '../scripts/pdf-raster-comparison.mjs';

function raster(width, height, colors) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [x, y, rgb] of colors) data.set([...rgb, 255], (y * width + x) * 4);
  return { width, height, data };
}
const colors = [[1, 1, [255, 0, 0]], [8, 1, [0, 180, 0]], [1, 8, [0, 0, 255]], [8, 8, [255, 128, 0]]];
test('comparison rejects wrong page geometry and blank output', () => {
  const image = raster(10, 10, colors);
  assert.throws(() => comparePdfRasters(image, raster(20, 5, [])), /dimensions/);
  assert.throws(() => comparePdfRasters(image, raster(10, 10, [])), /blank/);
});
test('rotation/crop landmarks allow raster rounding but reject displaced or missing corners', () => {
  const image = raster(10, 10, colors);
  const rounded = raster(10, 10, colors.map(([x, y, color]) => [x + 1, y, color]));
  assert.equal(comparePdfRasters(image, rounded, { landmarks: true }).landmarks.tolerancePixels, 1);
  const displaced = raster(10, 10, colors.map(([x, y, color]) => [x, y === 1 ? 3 : y, color]));
  assert.throws(() => comparePdfRasters(image, displaced, { landmarks: true }), /landmarks/);
  assert.throws(() => comparePdfRasters(image, raster(10, 10, colors.slice(1)), { landmarks: true }), /landmarks/);
});
test('font raster differences are reported without declaring a fidelity threshold', () => {
  const a = raster(2, 1, [[0, 0, [0, 0, 0]]]), b = raster(2, 1, [[0, 0, [30, 60, 90]]]);
  assert.equal(comparePdfRasters(a, a).meanAbsoluteRGB, 0);
  assert.equal(comparePdfRasters(a, b).meanAbsoluteRGB, 30);
  assert.equal(comparePdfRasters(a, b).changedPixelFraction, 0.5);
});
