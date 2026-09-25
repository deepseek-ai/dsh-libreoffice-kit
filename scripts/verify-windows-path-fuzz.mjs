/** Differential fuzzing of the built SAL URL parser against Win32 and real files. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';

const seed = 0x52210102;
let state = seed;
function random(limit) {
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  return (state >>> 0) % limit;
}
const choose = values => values[random(values.length)];
const decode = hex => Array.from({ length: hex.length / 4 }, (_, index) => String.fromCharCode(parseInt(hex.slice(index * 4, index * 4 + 4), 16))).join('');
const uncRoot = process.argv[4];
if (uncRoot) assert.match(uncRoot, /^\\\\[^\\]+\\[^\\]+$/, 'UNC root must name the temporary drive share, e.g. \\\\host\\C$');
assert.equal(process.platform, 'win32');
assert.ok(process.argv[2] && process.argv[3], 'Usage: verify-windows-path-fuzz.mjs <probe.exe> <receipt.json> [UNC-drive-share]');
const root = await mkdtemp(join(tmpdir(), 'lo-fuzz-'));
const corpus = [];
try {
  for (let index = 0; index < 1000; index++) {
    const targetLength = index < 300 ? 240 + index % 30 : 280 + random(1200);
    const unc = Boolean(uncRoot) && index % 2 === 1;
    const local = join(root, `case-${index}`);
    const prefix = unc ? `${uncRoot}${local.slice(2)}` : local;
    const segments = [];
    while (prefix.length + segments.join('\\').length + 18 < targetLength) {
      segments.push(choose(['目录', 'école', '日本語', '한글', 'emoji😀', 'space name', 'a#b%25', 'a+b;=@', 'a.b', '_abc'])
        + 'x'.repeat(random(40)));
    }
    const pathSegments = segments.map(part => choose([part, `.\\${part}`, `cancel\\..\\${part}`, `${part}\\.`, `${part}\\\\`, `one\\two\\..\\..\\${part}`]));
    let raw = `${prefix}\\${pathSegments.join('\\')}\\f-${index}.txt`;
    if (index < 300) {
      // Exact input lengths around both the SAL and Win32 prefix thresholds.
      const suffix = `\\cancel\\..\\.\\\\f-${index}.txt`;
      const length = index < 60 ? prefix.length + suffix.length + 8 : targetLength;
      let padding = 'a'.repeat(length - prefix.length - suffix.length - 1);
      if (padding.length > 100) padding = padding.slice(0, 100) + '\\' + padding.slice(101);
      raw = `${prefix}\\${padding}${suffix}`;
      assert.equal(raw.length, length);
    } else if (index % 10 === 0) {
      raw = `${prefix}\\${'a'.repeat(255)}\\cancel\\..\\f-${index}.txt`;
    }
    const canonical = win32.normalize(raw);
    // Create through Win32's extended form, without depending on host long-path policy.
    const localCanonical = unc ? local.slice(0, 2) + canonical.slice(uncRoot.length) : canonical;
    const physical = win32.toNamespacedPath(localCanonical);
    await mkdir(win32.dirname(physical), { recursive: true });
    await writeFile(physical, 'fuzz 42', { flag: 'wx' });
    const url = 'file:///' + raw.replaceAll('\\', '/').split('/').map((part, i) => i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
    corpus.push({ index, unc, length: raw.length, url, raw });
  }
  const input = corpus.map(test => `${test.url}\t${test.raw}`).join('\n') + '\n';
  const child = execFile(process.argv[2], [], { windowsHide: true, timeout: 180_000, maxBuffer: 32 * 1024 * 1024 }, () => {});
  const completion = new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', (code, signal) => code === 0 ? resolve(stdout) : reject(new Error(`probe exit ${code}, signal ${signal}: ${stderr}`)));
  });
  child.stdin.end(input);
  const lines = (await completion).trimEnd().split(/\r?\n/);
  assert.equal(lines.length, corpus.length);
  const failures = [];
  lines.forEach((line, index) => {
    const [error, equal, openError, content, actual, expected] = line.split('\t');
    if (error !== '0' || equal !== '1' || openError !== '0' || content !== '1') {
      failures.push({ ...corpus[index], error: Number(error), equal: equal === '1', openError: Number(openError), content: content === '1', actual: decode(actual), expected: decode(expected) });
    }
  });
  const uncCount = corpus.filter(test => test.unc).length;
  const receipt = { seed, count: corpus.length, drive: corpus.length - uncCount, unc: uncCount, minLength: Math.min(...corpus.map(test => test.length)), maxLength: Math.max(...corpus.map(test => test.length)), failures };
  await writeFile(process.argv[3], JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ ...receipt, failures: failures.length }));
  process.exitCode = failures.length ? 1 : 0;
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
