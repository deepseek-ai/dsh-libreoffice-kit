/** The source test worker uses the same ESM-only TypeScript loader as the dsh CLI. */
import { register } from 'tsx/esm/api';
register();
await import('../src/worker.ts');
