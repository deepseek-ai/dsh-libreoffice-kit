/** Deterministic removal of desktop resources from the Node WASM filesystem image. */

function desktopResource(filename) {
  const ui = '/instdir/share/config/soffice.cfg/';
  if (filename.startsWith(ui)) {
    const relative = filename.slice(ui.length);
    return relative.split('/').at(-1).startsWith('notebookbar') || /(?:^|\/)(?:toolbar|menubar)\//.test(relative);
  }
  return /^\/instdir\/share\/config\/images(?:_[a-z0-9_]+)?\.zip$/.test(filename)
    || filename.startsWith('/android/default-document/')
    || /^\/instdir\/program\/intro(?:-highres)?\.png$/.test(filename)
    || filename.startsWith('/instdir/program/shell/');
}

/**
 * Repack a complete Emscripten filesystem image without changing retained bytes.
 * Reject malformed inventories before returning any output. The loader reads its
 * preload size from the returned metadata's remote_package_size field.
 * @param data - Original filesystem image bytes.
 * @param metadata - Parsed Emscripten filesystem inventory.
 * @returns Repacked bytes, contiguous inventory, and removed resource sizes.
 */
export function slimWasmData(data, metadata) {
  if (!Buffer.isBuffer(data) || !metadata || !Array.isArray(metadata.files)
    || metadata.remote_package_size !== data.length) throw new Error('WASM data size differs from its metadata');
  const names = new Set();
  let cursor = 0;
  for (const file of metadata.files) {
    if (!file || typeof file.filename !== 'string' || !file.filename.startsWith('/')
      || file.filename.slice(1).split('/').some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))
      || names.has(file.filename)) throw new Error('Invalid or duplicate WASM resource path');
    names.add(file.filename);
    if (!Number.isSafeInteger(file.start) || !Number.isSafeInteger(file.end)
      || file.start !== cursor || file.end < file.start || file.end > data.length) {
      throw new Error(`WASM resource ranges do not continuously cover the data: ${file.filename}`);
    }
    cursor = file.end;
  }
  if (cursor !== data.length) throw new Error('WASM resource inventory does not cover the complete data');
  const chunks = [];
  const files = [];
  const removed = [];
  let offset = 0;
  for (const file of metadata.files) {
    const bytes = file.end - file.start;
    if (desktopResource(file.filename)) {
      removed.push({ filename: file.filename, bytes });
    } else {
      chunks.push(data.subarray(file.start, file.end));
      files.push({ ...file, start: offset, end: offset + bytes });
      offset += bytes;
    }
  }
  if (offset === 0) throw new Error('WASM slimming would remove the complete filesystem image');
  return {
    data: Buffer.concat(chunks, offset),
    metadata: { ...metadata, files, remote_package_size: offset },
    removed,
    removedBytes: data.length - offset,
  };
}
