/** IPC readiness barrier for independent cache publishers using the real scanner. */
import { register } from 'tsx/esm/api';
register();
const { scanFontSnapshot } = await import('../src/font-snapshot.ts');
const { writeFontMetadataCache } = await import('../src/font-metadata-cache.ts');
process.once('message', ({ options, temporaryPath }) => {
  try {
    const snapshot = scanFontSnapshot(options);
    writeFontMetadataCache(options, snapshot.records, temporaryPath);
    process.send({ ok: true, records: snapshot.records.length, faces: snapshot.faces.length }, () => process.disconnect());
  } catch {
    process.send({ ok: false }, () => process.disconnect());
  }
});
process.send({ ready: true });
