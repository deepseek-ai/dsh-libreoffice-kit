/** Prepare the native build checkout from the pinned Core submodule. */
import { join } from 'node:path';
import { root } from './platform-matrix.mjs';
import { checkoutCore } from './core-checkout.mjs';

checkoutCore(join(root, '.build/core'));
