/** Own benchmark process groups, logs, and bounded process-tree RSS sampling. */
import { createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const commandOptions = { timeout: 2_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 };

/** Run an owned child group; deadlines include termination and sampling cleanup. */
export async function runMeasuredProcess(command, args, directory, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 0x7fffffff) throw new RangeError('Benchmark deadline exceeds the Node timer range.');
  const child = spawn(command, args, { detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const logged = Promise.all([
    pipeline(child.stdout, createWriteStream(join(directory, 'stdout.log'), { flags: 'wx' })),
    pipeline(child.stderr, createWriteStream(join(directory, 'stderr.log'), { flags: 'wx' })),
  ]);
  void logged.catch(() => {});
  let spawnFailure;
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnFailure = error; });
    child.once('close', (code, signal) => resolve({ exitCode: code, exitSignal: signal }));
  });
  let peakRssKiB = 0, samples = 0, sampleFailure;
  let samplePending;
  const sampleAbort = new AbortController();
  const sampler = setInterval(() => {
    if (samplePending || process.platform === 'win32' || !child.pid) return;
    samplePending = (async () => {
      try {
        const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss='], { ...commandOptions, signal: sampleAbort.signal });
        const processes = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
        const descendants = new Set([child.pid]);
        for (let previous = -1; previous !== descendants.size;) {
          previous = descendants.size;
          for (const [pid, ppid] of processes) if (descendants.has(ppid)) descendants.add(pid);
        }
        if (processes.some(([pid]) => pid === child.pid)) {
          peakRssKiB = Math.max(peakRssKiB, processes.reduce((sum, [pid, , rss]) => sum + (descendants.has(pid) ? rss : 0), 0));
          samples++;
        }
      } catch (error) { if (!sampleAbort.signal.aborted) sampleFailure = String(error); }
      finally { samplePending = undefined; }
    })();
  }, 100);
  let killed = false;
  let termination;
  let exit;
  let failure;
  let deadline;
  let rejectInterruption;
  const interruption = new Promise((_, reject) => { rejectInterruption = reject; });
  const interrupted = signal => { killed = true; rejectInterruption(new Error(`Benchmark interrupted by ${signal}.`)); };
  const onSigint = () => interrupted('SIGINT');
  const onSigterm = () => interrupted('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  const terminate = () => termination ??= (async () => {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], { ...commandOptions, timeout: 5_000 });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  })();
  try {
    const expired = new Promise((_, reject) => { deadline = setTimeout(() => { killed = true; reject(new Error('Benchmark process deadline exceeded.')); }, timeoutMs); });
    exit = await Promise.race([closed, expired, interruption]);
    if (spawnFailure) throw spawnFailure;
    await logged;
  } catch (error) { failure = error; }
  finally {
    clearTimeout(deadline);
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    clearInterval(sampler);
    sampleAbort.abort();
    if (samplePending) await samplePending;
    if (killed || failure || process.platform !== 'win32') {
      try { await terminate(); } catch (error) { failure = new AggregateError(failure ? [failure, error] : [error], 'Benchmark process group cleanup failed.'); }
    }
    let cleanupTimer;
    try {
      exit ??= await Promise.race([closed, new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Benchmark child did not close after termination.')), 5_000); })]);
    } catch (error) { failure = new AggregateError(failure ? [failure, error] : [error], 'Benchmark child cleanup failed.'); }
    finally { clearTimeout(cleanupTimer); child.stdout.destroy(); child.stderr.destroy(); }
    await logged.catch(error => { failure ??= error; });
  }
  return { ...exit, killed, processTreePeakRssMiB: samples > 0 ? peakRssKiB / 1024 : null, rssSamples: samples,
    sampleFailure, ...(failure ? { failure: String(failure) } : {}) };
}
