/** Validate engine versions after pnpm resolves workspace dependencies. */
import { kitPackageName } from './platform-matrix.mjs';
import { verifyKitMetadata } from './verify-kit.mjs';

/**
 * Application builds override these exact versions with authenticated local engine archives.
 * @param manifest - Exportable manifest after pnpm has resolved workspace ranges.
 * @returns The validated adapter manifest, or the unchanged unrelated manifest.
 */
export function packKitManifest(manifest) {
  if (manifest.name !== kitPackageName) return manifest;
  return verifyKitMetadata(manifest, true);
}
