/** Reject undersized GitHub Actions hosts before compiling LibreOffice Core. */
import { availableParallelism, totalmem } from 'node:os';
import { isMain } from './platform-matrix.mjs';

/** Require a larger host on every OS, and at least 16 vCPUs for Windows. */
export function verifyCoreBuildResources(platform, cpus) {
  const minimum = platform === 'win32' ? 16 : 5;
  if (!Number.isInteger(cpus) || cpus < minimum)
    throw new Error(`Core compilation on ${platform} requires at least ${minimum} vCPUs; standard 4-vCPU runners are forbidden. Select a larger runner or an approved build host.`);
}

if (isMain(import.meta.url)) {
  const cpus = availableParallelism();
  console.log(JSON.stringify({ platform: process.platform, cpus, memoryGiB: totalmem() / 2 ** 30 }));
  verifyCoreBuildResources(process.platform, cpus);
}
