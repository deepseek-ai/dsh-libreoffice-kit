/** Pack the adapter with the matching internal engine Release URLs. */
import { packKitManifest } from './scripts/pack-kit-manifest.mjs';

export const hooks = { beforePacking: packKitManifest };
