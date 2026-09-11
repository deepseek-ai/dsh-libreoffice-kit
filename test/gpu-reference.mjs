/** Float64 CPU reference with precomputed taps and RGBA8 inter-pass quantization. */
function coefficients(sourceSize, targetSize) {
  const scale = sourceSize / targetSize;
  const stretch = Math.max(scale, 1);
  const sinc = value => Math.abs(value) < 0.00001 ? 1 : Math.sin(Math.PI * value) / (Math.PI * value);
  return Array.from({ length: targetSize }, (_, dest) => {
    const center = (dest + 0.5) * scale - 0.5;
    const first = Math.ceil(center - 3 * stretch);
    const count = Math.floor(center + 3 * stretch) - first + 1;
    const indices = new Int32Array(count);
    const weights = new Float64Array(count);
    let sum = 0;
    for (let i = 0; i < count; i++) {
      indices[i] = Math.min(sourceSize - 1, Math.max(0, first + i));
      const position = (first + i - center) / stretch;
      weights[i] = sinc(position) * sinc(position / 3);
      sum += weights[i];
    }
    for (let i = 0; i < count; i++) weights[i] /= sum;
    return { indices, weights };
  });
}

/** Compute both separable passes independently of the WGSL implementation. */
export function cpuScale(input, width, height, targetWidth, targetHeight) {
  const horizontal = coefficients(width, targetWidth);
  const vertical = coefficients(height, targetHeight);
  const intermediate = new Uint8Array(targetWidth * height * 4);
  const output = new Uint8Array(targetWidth * targetHeight * 4);
  const byte = value => Math.min(255, Math.max(0, Math.round(value)));
  const sample = (source, destination, at, origin, stride, { indices, weights }) => {
    let red = 0, green = 0, blue = 0, alpha = 0;
    for (let tap = 0; tap < indices.length; tap++) {
      const offset = origin + indices[tap] * stride;
      const weight = weights[tap];
      red += source[offset] * weight;
      green += source[offset + 1] * weight;
      blue += source[offset + 2] * weight;
      alpha += source[offset + 3] * weight;
    }
    destination[at] = byte(red);
    destination[at + 1] = byte(green);
    destination[at + 2] = byte(blue);
    destination[at + 3] = byte(alpha);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < targetWidth; x++) sample(input, intermediate, (y * targetWidth + x) * 4, y * width * 4, 4, horizontal[x]);
  }
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) sample(intermediate, output, (y * targetWidth + x) * 4, x * 4, targetWidth * 4, vertical[y]);
  }
  return output;
}

/** Fixed opaque RGBA fixtures include orientation, border and aliasing information. */
export function pixels(width, height, kind = 'mixed') {
  const bytes = new Uint8Array(width * height * 4);
  let state = 1234567;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      const checker = ((x ^ y) & 1) * 255;
      bytes[offset] = kind === 'constant' ? 37 : kind === 'checker' ? checker : Math.round(x * 255 / Math.max(width - 1, 1));
      bytes[offset + 1] = kind === 'constant' ? 137 : kind === 'checker' ? checker : Math.round(y * 255 / Math.max(height - 1, 1));
      bytes[offset + 2] = kind === 'constant' ? 237 : kind === 'checker' ? checker : state >>> 24;
      bytes[offset + 3] = 255;
    }
  }
  return bytes;
}

/** Report channel error without concealing flips, mismatched dimensions or alpha changes. */
export function pixelError(actual, expected) {
  if (actual.length !== expected.length) throw new Error('Pixel lengths differ.');
  let maximum = 0, total = 0, different = 0;
  for (let i = 0; i < actual.length; i++) {
    const error = Math.abs(actual[i] - expected[i]);
    maximum = Math.max(maximum, error);
    total += error;
    if (error) different++;
  }
  return { maximum, mean: total / actual.length, different, channels: actual.length };
}
