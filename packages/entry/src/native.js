/** Per-render native helper process ownership and bounded result transport. */
import { spawn } from 'node:child_process';
import { ConversionError, failureCode } from './errors.js';

/** Linux searches the verified program directory; ambient loader overrides and credentials are excluded. */
export function nativeEnvironment(profile, programDirectory, source = process.env, platform = process.platform) {
  const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']
    .filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (platform === 'linux') env.LD_LIBRARY_PATH = programDirectory;
  return Object.assign(env, { HOME: profile, USERPROFILE: profile, TMPDIR: profile, TMP: profile, TEMP: profile });
}

export async function runNative(engine, options, input, output, profile, fonts, signal) {
  signal.throwIfAborted();
  const env = nativeEnvironment(profile, engine.programDirectory);
  const child = spawn(engine.executable, ['--program-directory', engine.programDirectory, '--input-path', input,
    '--output-path', output, '--profile-directory', profile, '--max-output-bytes', String(options.maxOutputBytes),
    '--max-image-resolution', String(options.maxImageResolution), ...fonts.flatMap(path => ['--font-file', path])],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  let stdout = '';
  let stderr = '';
  let failure;
  const abort = () => { failure ??= signal.reason; child.kill('SIGKILL'); };
  signal.addEventListener('abort', abort, { once: true });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.length > 65_536) { failure ??= new Error('LibreOffice helper exceeded its response limit.'); child.kill('SIGKILL'); }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65_536); });
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', error => { failure ??= error; });
      child.once('close', (code, signal) => {
        if (signal === 'SIGXFSZ') failure ??= new ConversionError('output-too-large', 'LibreOffice exceeded its output file-size limit.');
        if (failure) reject(failure); else resolve(code);
      });
      if (signal.aborted) abort();
    });
    signal.throwIfAborted();
    let result;
    try { result = JSON.parse(stdout); } catch (cause) { throw new Error(`LibreOffice helper returned an invalid response (exit ${code}). ${stderr}`, { cause }); }
    if (code !== 0 || result.ok !== true) throw new ConversionError(failureCode(result), `LibreOffice native conversion failed: ${result.error ?? stderr ?? `exit ${code}`}`);
  } finally { signal.removeEventListener('abort', abort); }
}
