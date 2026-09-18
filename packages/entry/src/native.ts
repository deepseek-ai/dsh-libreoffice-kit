/** Per-render native helper process ownership and bounded result transport. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ConversionError, failureCode } from './errors.ts'
import { profileXml } from './profile.ts'
import { LOCALIZED_FONT_SEARCH_NAMES } from './native-font-names.ts'
import type { FontSubstitution } from './font-loader.ts'
import type { ConversionSpec } from './operations.ts'
import type { NativeEngine } from './engine.ts'
import type { ResolvedOptions } from './options.ts'

// LibreOffice 26.8 PhysicalFontCollection retains these search names when the compatible font is absent.
const METRIC_SEARCH_NAMES = new Map<string, string>([
  ['timesnewroman', 'liberationserif'], ['arial', 'liberationsans'], ['arialnarrow', 'liberationsansnarrow'],
  ['couriernew', 'liberationmono'], ['cambria', 'caladea'], ['calibri', 'carlito'],
  ['bundessans', 'calibri'], ['bundessansoffice', 'calibri'], ['bundessansregular', 'calibri'],
  ['bundesserif', 'cambria'], ['bundesserifoffice', 'cambria'], ['bundesserifregular', 'cambria'],
])

/** Environment variables the helper inherits from the embedding process. */
const NATIVE_ENVIRONMENT_KEYS = ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ'] as const

function fontSearchName(value: string): string {
  const name = value.replaceAll(/[\uff00-\uff5e]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replaceAll(/[A-Z]/g, character => character.toLowerCase()).replaceAll(/[^a-z0-9;()\u0080-\uffff]/g, '')
  return LOCALIZED_FONT_SEARCH_NAMES.get(name) ?? name
}

/**
 * Write missing-family choices into the private profile's VCL substitution table.
 * Installed originals and metric-compatible fonts are resolved before this table by LibreOffice.
 * @param profile - Existing, conversion-owned profile directory.
 * @param substitutions - Missing document families and the selected installed family.
 * @returns Resolves after the exclusive profile file is written; empty choices still disable the interactive CSV warning.
 */
export async function prepareNativeFontProfile(profile: string, substitutions: readonly FontSubstitution[]): Promise<void> {
  const families = new Map<string, string>(substitutions.map(({ family, substitute }) => [fontSearchName(family), substitute] as const))
  for (const [family, substitute] of [...families]) {
    for (let alias = METRIC_SEARCH_NAMES.get(family); alias; alias = METRIC_SEARCH_NAMES.get(alias)) {
      if (!families.has(alias)) families.set(alias, substitute)
    }
  }
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  const nodes = [...families].map(([family, substitute]) => `<node oor:name="${escape(family)}" oor:op="replace"><prop oor:name="SubstFonts" oor:op="fuse"><value>${escape(substitute)}</value></prop></node>`).join('')
  const xml = profileXml(nodes)
  const user = join(profile, 'user')
  await mkdir(user, { mode: 0o700 })
  await writeFile(join(user, 'registrymodifications.xcu'), xml, { flag: 'wx', mode: 0o600 })
}

/**
 * Linux searches the verified program directory; ambient loader overrides and credentials are excluded.
 * @param profile - Conversion-owned profile directory the helper treats as home.
 * @param programDirectory - Verified engine program directory.
 * @param source - Embedding process environment.
 * @param platform - Host operating system.
 * @returns the environment the helper starts with.
 */
export function nativeEnvironment(profile: string, programDirectory: string, source: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of NATIVE_ENVIRONMENT_KEYS) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  if (platform === 'linux') env.LD_LIBRARY_PATH = programDirectory
  return Object.assign(env, { HOME: profile, USERPROFILE: profile, TMPDIR: profile, TMP: profile, TEMP: profile })
}

/**
 * Run one native conversion and await bounded result transport.
 * @param engine - Resolved native engine installation.
 * @param options - Validated conversion limits.
 * @param input - Private source path inside the conversion scratch directory.
 * @param output - Private PDF path inside the conversion scratch directory.
 * @param profile - Conversion-owned profile directory.
 * @param fonts - Installed font files the helper may load.
 * @param substitutions - Missing families and their selected installed substitutes.
 * @param signal - Cancellation; it kills the helper and awaits its exit.
 * @param operation - Validated output format, recalculation, and worksheet selection.
 * @throws ConversionError for a reported conversion failure, and the abort reason for cancellation.
 */
export async function runNative(engine: NativeEngine, options: ResolvedOptions, input: string, output: string, profile: string,
  fonts: readonly string[], substitutions: readonly FontSubstitution[], signal: AbortSignal, operation: Pick<ConversionSpec, 'format' | 'recalculate' | 'sheet'>): Promise<void> {
  signal.throwIfAborted()
  await prepareNativeFontProfile(profile, substitutions)
  signal.throwIfAborted()
  const env = nativeEnvironment(profile, engine.programDirectory)
  const child = spawn(engine.executable, ['--program-directory', engine.programDirectory, '--input-path', input,
    '--output-path', output, '--profile-directory', profile, '--max-output-bytes', String(options.maxOutputBytes),
    '--max-image-resolution', String(options.maxImageResolution), '--format', operation.format, '--recalculate', String(operation.recalculate),
    ...(operation.sheet === undefined ? [] : ['--sheet', operation.sheet]), ...fonts.flatMap(path => ['--font-file', path])],
  { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env })
  let stdout = ''
  let stderr = ''
  let failure: Error | undefined
  const abort = () => { failure ??= signal.reason; child.kill('SIGKILL') }
  signal.addEventListener('abort', abort, { once: true })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
    if (stdout.length > 65_536) { failure ??= new Error('LibreOffice helper exceeded its response limit.'); child.kill('SIGKILL') }
  })
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65_536) })
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', (error) => { failure ??= error })
      child.once('close', (code, signal) => {
        if (signal === 'SIGXFSZ') failure ??= new ConversionError('output-too-large', 'LibreOffice exceeded its output file-size limit.')
        if (failure) reject(failure); else resolve(code)
      })
    })
    signal.throwIfAborted()
    let result: { ok?: boolean; error?: string }
    try { result = JSON.parse(stdout) as { ok?: boolean; error?: string } } catch (cause) { throw new Error(`LibreOffice helper returned an invalid response (exit ${code}). ${stderr}`, { cause }) }
    if (code !== 0 || result.ok !== true) throw new ConversionError(failureCode(result), `LibreOffice native conversion failed: ${result.error ?? stderr}`)
  } finally { signal.removeEventListener('abort', abort) }
}
