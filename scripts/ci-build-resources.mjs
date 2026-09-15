/** Bound Core parallelism by CPU and memory, with an explicit per-target CI override. */
import { appendFileSync, statfsSync } from 'node:fs';
import { availableParallelism, release, totalmem } from 'node:os';
import { isMain, targets } from './platform-matrix.mjs';

export function buildJobs(platform, override = '', { cpus = availableParallelism(), memory = totalmem() } = {}) {
  if (platform !== 'wasm' && !Object.hasOwn(targets, platform)) throw new Error(`Unknown build platform: ${platform}`);
  if (override !== '') {
    if (!/^[1-9][0-9]*$/.test(String(override)) || !Number.isSafeInteger(Number(override)))
      throw new Error('LIBREOFFICE_KIT_BUILD_JOBS must be a positive integer for this platform');
    return Number(override);
  }
  const gib = 1024 ** 3;
  // Leave room for configure, generators and the linker; override after measuring a runner.
  const memoryJobs = Math.floor((memory - 2 * gib) / ((platform === 'wasm' ? 2 : 1.5) * gib));
  return Math.max(1, Math.min(cpus, memoryJobs));
}

if (isMain(import.meta.url)) {
  const platform = process.argv[2];
  const jobs = buildJobs(platform, process.env.LIBREOFFICE_KIT_BUILD_JOBS ?? '');
  const image = `${process.env.ImageOS ?? process.platform}-${process.env.ImageVersion ?? release()}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const resources = { platform, image, jobs, cpus: availableParallelism(), memoryGiB: +(totalmem() / 1024 ** 3).toFixed(1) };
  try {
    const disk = statfsSync('.');
    resources.freeDiskGiB = +(disk.bavail * disk.bsize / 1024 ** 3).toFixed(1);
  } catch { /* Disk statistics are not available on every development host. */ }
  console.log(JSON.stringify(resources));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `jobs=${jobs}\nimage-key=${image}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### ${platform} build resources\n\n${Object.entries(resources).map(([key, value]) => `- ${key}: ${value}`).join('\n')}\n`);
}
