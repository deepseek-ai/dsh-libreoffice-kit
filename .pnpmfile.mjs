/** Validate the adapter’s exact engine versions before packing. */
import { packKitManifest } from './scripts/pack-kit-manifest.mjs';

export const hooks = { beforePacking: packKitManifest };
