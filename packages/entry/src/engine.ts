/** Resolve installed, version-matched engine packages without downloads or compilation. */
import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, resolve, relative, sep, join } from 'node:path'

const require = createRequire(import.meta.url)

/**
 * Engine-family version every installed engine package must carry. The engine
 * family shares its release version with this Node API.
 */
export const ENGINE_VERSION = '0.0.2-rc5'

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

/**
 * Resolve the shared WASM engine on every supported operating system.
 * @param resolvePackage - Package manifest resolver; injectable for selection tests.
 * @param _packageExists - Retained positional compatibility with earlier resolvers.
 * @param host - Process identification and diagnostic report.
 * @returns the installed WASM engine; native packages never change selection.
 */
export async function resolveEngine(resolvePackage: (name: string) => string = name => require.resolve(`${name}/package.json`),
  _packageExists: (name: string) => boolean = installedPackageExists,
  { platform = process.platform, arch = process.arch }: EngineResolutionHost = {}): Promise<Engine> {
  if (!['darwin', 'win32', 'linux'].includes(platform)) throw new Error(`Unsupported LibreOfficeKit host: ${platform}-${arch}`)
  return readEngine(resolvePackage(`${ENGINE_PREFIX}-wasm`))
}

async function engineAsset(root: string, value: unknown, name: string): Promise<string> {
  const path = asset(root, value)
  const status = await stat(path)
  if (!status.isFile()) throw new Error(`Installed LibreOfficeKit ${name} is not a file.`)
  return path
}

async function readEngine(packageFile: string): Promise<WasmEngine> {
  const root = dirname(packageFile)
  const [pkg, manifest] = await Promise.all([
    readFile(packageFile, 'utf8').then(text => JSON.parse(text) as EngineManifest),
    readFile(resolve(root, 'prebuilds.json'), 'utf8').then(text => JSON.parse(text) as EnginePrebuildManifest),
  ])
  const engine = manifest.engine
  if (pkg.name !== `${ENGINE_PREFIX}-wasm` || pkg.version !== ENGINE_VERSION || manifest.version !== pkg.version || manifest.schemaVersion !== 1 || manifest.status !== 'built'
    || engine === undefined || engine.kind !== 'wasm' || manifest.platform !== 'wasm') throw new Error('Installed LibreOfficeKit wasm package has an incompatible or incomplete manifest.')
  if (engine.glibcMinimum !== undefined) throw new Error('Installed LibreOfficeKit engine has an invalid glibcMinimum.')
  // The WASM engine addresses its program resources inside the module's virtual filesystem.
  const programDirectory = String(engine.programDirectory)
  const loader = await engineAsset(root, engine.loader, 'loader')
  const wasm = await engineAsset(root, engine.wasm, 'wasm')
  const data = await engineAsset(root, engine.data, 'data')
  const metadata = await engineAsset(root, engine.metadata, 'metadata')
  return { backend: 'wasm', root, programDirectory, loader, wasm, data, metadata }
}
