/** Pixel allocation limits shared by the synchronous bridge and GPU worker. */

/**
 * Account for WASM arrays, shared staging, upload, storage, and readback pixels.
 * Driver bookkeeping and the rest of LibreOffice's memory are not included.
 * @returns {object|null} Valid downscale dimensions and byte counts, or null.
 */
export function scaleLayout(width, height, targetWidth, targetHeight, maxGpuBytes) {
  const dimensions = [width, height, targetWidth, targetHeight];
  if (dimensions.some(value => !Number.isSafeInteger(value) || value < 1 || value > 0x7fffffff)) return null;
  if (targetWidth > width || targetHeight > height || (width === targetWidth && height === targetHeight)) return null;
  const inputBytes = width * height * 4;
  const intermediateBytes = targetWidth * height * 4;
  const outputBytes = targetWidth * targetHeight * 4;
  const estimatedBytes = 4 * inputBytes + intermediateBytes + 4 * outputBytes + 512;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > maxGpuBytes) return null;
  return { width, height, targetWidth, targetHeight, inputBytes, intermediateBytes, outputBytes, estimatedBytes };
}
