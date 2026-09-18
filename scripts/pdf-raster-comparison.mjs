/** Browser/Node pixel checks. Differences are evidence, not a general PDF fidelity score. */
export function comparePdfRasters(actual, expected, { landmarks = false } = {}) {
  if (actual.width !== expected.width || actual.height !== expected.height) throw new Error('PDF raster dimensions differ.');
  const pixels = actual.width * actual.height;
  if (pixels < 1 || actual.data.length !== pixels * 4 || expected.data.length !== pixels * 4) throw new Error('Invalid RGBA raster.');
  let sum = 0, changed = 0, inkActual = 0, inkExpected = 0;
  for (let i = 0; i < actual.data.length; i += 4) {
    let difference = false;
    for (let c = 0; c < 3; c++) { const delta = Math.abs(actual.data[i + c] - expected.data[i + c]); sum += delta; difference ||= delta > 0; }
    if (difference) changed++;
    if (Math.min(...actual.data.subarray(i, i + 3)) < 240) inkActual++;
    if (Math.min(...expected.data.subarray(i, i + 3)) < 240) inkExpected++;
  }
  if (!inkActual || !inkExpected) throw new Error('PDF raster is blank.');
  const result = { width: actual.width, height: actual.height, meanAbsoluteRGB: sum / (pixels * 3), changedPixelFraction: changed / pixels, inkPixels: [inkActual, inkExpected] };
  if (landmarks) {
    const bounds = image => {
      const rectangles = [null, null, null, null];
      for (let i = 0; i < image.data.length; i += 4) {
        const [r, g, b] = image.data.subarray(i, i + 3);
        const color = r > 240 && g < 20 && b < 20 ? 0 : r < 20 && g > 150 && b < 20 ? 1 : r < 20 && g < 20 && b > 240 ? 2 : r > 240 && g > 100 && g < 150 && b < 20 ? 3 : -1;
        if (color < 0) continue;
        const x = (i / 4) % image.width, y = Math.floor(i / 4 / image.width), old = rectangles[color];
        rectangles[color] = old ? [Math.min(old[0], x), Math.min(old[1], y), Math.max(old[2], x), Math.max(old[3], y)] : [x, y, x, y];
      }
      return rectangles;
    };
    const a = bounds(actual), b = bounds(expected);
    if (a.some((rectangle, i) => !rectangle || !b[i] || rectangle.some((n, j) => Math.abs(n - b[i][j]) > 1))) throw new Error('PDF rotation/crop color landmarks differ.');
    result.landmarks = { actual: a, expected: b, tolerancePixels: 1 };
  }
  return result;
}
