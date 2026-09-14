/** Resolve installed, version-matched engine packages without downloads or compilation. */
import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, resolve, relative, sep, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Engine-family version every installed engine package must carry. The engine
 * family releases under its own version, independently of this adapter.
 */
export const ENGINE_VERSION = '0.0.1'

/** npm scope and name prefix shared by the engine packages this adapter installs. */
const ENGINE_PREFIX = '@deepseek-ai/libreoffice-kit'

/** Host diagnostic fields used to identify the runtime glibc version. */
export interface EngineHostReport {
  readonly header?: { readonly glibcVersionRuntime?: string }
}

/** Process identification and diagnostic report the resolver classifies the host with. */
export interface EngineResolutionHost {
  readonly platform?: string
  readonly arch?: string
  readonly report?: () => EngineHostReport
}

/** Engine installation fields both backends carry. */
interface EngineInstallation {
  /** Installed package root the manifest resolved to. */
  readonly root: string
  /** Program resources the engine loads: a real directory natively, a virtual path in WASM. */
  readonly programDirectory: string
  /** Recorded glibc floor when the native manifest declares one. */
  readonly glibcMinimum?: string
}

/** A resolved native LibreOfficeKit helper. */
export interface NativeEngine extends EngineInstallation {
  readonly backend: 'native'
  readonly executable: string
}

/** A resolved shared Node WebAssembly engine. */
export interface WasmEngine extends EngineInstallation {
  readonly backend: 'wasm'
  readonly loader: string
  readonly wasm: string
  readonly data: string
  readonly metadata: string
}

/** One resolved engine installation. */
export type Engine = NativeEngine | WasmEngine

/** Engine backend a conversion runs in. */
export type EngineBackend = Engine['backend']

/** Fields the engine manifest records; every asset path is validated before use. */
interface EngineAssets {
  readonly kind?: string
  readonly glibcMinimum?: unknown
  readonly executable?: unknown
  readonly programDirectory?: unknown
  readonly loader?: unknown
  readonly wasm?: unknown
  readonly data?: unknown
  readonly metadata?: unknown
}

/** The installed engine package manifest. */
interface EngineManifest {
  readonly name?: string
  readonly version?: string
}

/** The installed engine prebuild manifest. */
interface EnginePrebuildManifest {
  readonly schemaVersion?: number
  readonly version?: string
  readonly platform?: string
  readonly status?: string
  readonly engine?: EngineAssets
}

/**
 * Whether an installed engine package directory is present on the resolution path.
 * @param name - Engine package name.
 * @returns true when at least one resolution directory holds the package.
 */
export function installedPackageExists(name: string): boolean {
  return (require.resolve.paths(name) ?? []).some(directory => lstatSync(join(directory, name), { throwIfNoEntry: false }) !== undefined)
}

/**
 * Return the optional package target for the current process ABI.
 * @param platform - Host operating system.
 * @param arch - Host CPU architecture.
 * @param report - Host diagnostic report used to identify glibc.
 * @returns the declared platform target, or undefined for an unsupported host.
 */
export function platformTarget(platform: string = process.platform, arch: string = process.arch,
  report: () => EngineHostReport = hostReport): string | undefined {
  if (!['arm64', 'x64'].includes(arch)) return undefined
  if (platform === 'darwin' || platform === 'win32') return `${platform}-${arch}`
  if (platform !== 'linux') return undefined
  return report().header?.glibcVersionRuntime ? `linux-${arch}-glibc` : undefined
}

/** @returns the host diagnostic report as the engine resolver reads it. */
function hostReport(): EngineHostReport {
  return process.report.getReport()
}

function asset(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value || isAbsolute(value)) throw new Error('Engine manifest contains an invalid asset path.')
  const path = resolve(root, value)
  if (relative(root, path).startsWith(`..${sep}`) || relative(root, path) === '..') throw new Error('Engine asset escapes its installed package.')
  return path
}

function glibcVersion(value: unknown): number[] | undefined {
  return typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(value)
    && value.split('.').every(part => Number.isSafeInteger(Number(part))) ? value.split('.').map(Number) : undefined
}

/**
 * Absence or a known unsupported glibc version permits fallback; invalid installations reject.
 * @param resolvePackage - Package manifest resolver; injectable for selection tests.
 * @param packageExists - Installed-package probe; injectable for selection tests.
 * @param host - Process identification and diagnostic report.
 * @returns the installed native engine, or the required WASM engine.
 */
export async function resolveEngine(resolvePackage: (name: string) => string = name => require.resolve(`${name}/package.json`),
  packageExists: (name: string) => boolean = installedPackageExists,
  { platform = process.platform, arch = process.arch, report = hostReport }: EngineResolutionHost = {}): Promise<Engine> {
  const details = platform === 'linux' ? report() : {}
  const target = platformTarget(platform, arch, () => details)
  if (target !== undefined) {
    const name = `${ENGINE_PREFIX}-${target}`
    let packageFile: string | undefined
    try { packageFile = resolvePackage(name) } catch (error) {
      // Only failure to find this package permits fallback; broken exports are installation failures.
      const failure = error as { code?: unknown; message?: unknown } | null
      const missing = failure?.code === 'MODULE_NOT_FOUND' && typeof failure.message === 'string'
        && failure.message.includes(`${name}/package.json`)
      if (!missing) throw error
      if (packageExists(name)) throw new Error(`Installed LibreOfficeKit package is incomplete: ${name}`, { cause: error })
    }
    if (packageFile !== undefined) {
      const engine = await readEngine(packageFile, 'native', target)
      const minimum = glibcVersion(engine.glibcMinimum)
      const host = glibcVersion(details.header?.glibcVersionRuntime)
      const unsupported = minimum && host && minimum.some((part, index) => part > (host[index] ?? 0)
        && minimum.slice(0, index).every((prior, priorIndex) => prior === host[priorIndex]))
      if (!unsupported) return engine
    }
  }
  return readEngine(resolvePackage(`${ENGINE_PREFIX}-wasm`), 'wasm', 'wasm')
}

async function engineAsset(root: string, value: unknown, name: string, kind: 'file' | 'directory'): Promise<string> {
  const path = asset(root, value)
  const status = await stat(path)
  if (kind === 'directory' ? !status.isDirectory() : !status.isFile()) throw new Error(`Installed LibreOfficeKit ${name} is not a ${kind}.`)
  if (name === 'executable' && process.platform !== 'win32' && !(status.mode & 0o111)) throw new Error('Installed LibreOfficeKit executable is not executable.')
  return path
}

async function readEngine(packageFile: string, backend: EngineBackend, target: string): Promise<Engine> {
  const root = dirname(packageFile)
  const [pkg, manifest] = await Promise.all([
    readFile(packageFile, 'utf8').then(text => JSON.parse(text) as EngineManifest),
    readFile(resolve(root, 'prebuilds.json'), 'utf8').then(text => JSON.parse(text) as EnginePrebuildManifest),
  ])
  const engine = manifest.engine
  if (pkg.name !== `${ENGINE_PREFIX}-${target}` || pkg.version !== ENGINE_VERSION || manifest.version !== pkg.version || manifest.schemaVersion !== 1 || manifest.status !== 'built'
    || engine === undefined || engine.kind !== backend || manifest.platform !== target) throw new Error(`Installed LibreOfficeKit ${backend} package has an incompatible or incomplete manifest.`)
  const minimum = engine.glibcMinimum
  if (minimum !== undefined && (!target.endsWith('-glibc') || !glibcVersion(minimum))) throw new Error('Installed LibreOfficeKit engine has an invalid glibcMinimum.')
  const glibcFloor = minimum === undefined ? {} : { glibcMinimum: minimum as string }
  if (backend === 'native') {
    const executable = await engineAsset(root, engine.executable, 'executable', 'file')
    const directory = await engineAsset(root, engine.programDirectory, 'programDirectory', 'directory')
    return { backend, root, programDirectory: directory, executable, ...glibcFloor }
  }
  // The WASM engine addresses its program resources inside the module's virtual filesystem.
  const programDirectory = String(engine.programDirectory)
  const loader = await engineAsset(root, engine.loader, 'loader', 'file')
  const wasm = await engineAsset(root, engine.wasm, 'wasm', 'file')
  const data = await engineAsset(root, engine.data, 'data', 'file')
  const metadata = await engineAsset(root, engine.metadata, 'metadata', 'file')
  return { backend, root, programDirectory, loader, wasm, data, metadata, ...glibcFloor }
}
