import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SaxesParser } from 'saxes'
import { nativeEnvironment, prepareNativeFontProfile, runNative } from '../src/native.ts'
import { resolveOptions } from '../src/options.ts'
import type { NativeEngine } from '../src/engine.ts'
import type { FontSubstitution } from '../src/font-loader.ts'
import { spawn, type SpawnOptions } from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn((file: string, args: readonly string[], options: SpawnOptions) =>
      file.endsWith('.cjs') ? actual.spawn(process.execPath, [file, ...args], options) : actual.spawn(file, args, options)),
  }
})

afterEach(() => { vi.resetAllMocks() })

/** One private directory removed after `body` settles. */
async function withTemporaryDirectory<T>(body: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-kit-native-'))
  try { return await body(root) } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
}

/** The substitution records a profile file declares, parsed from its registry XML. */
function substitutions(xml: string): Map<string, string> {
  const parser = new SaxesParser()
  const families = new Map<string, string>()
  let item = ''
  let family = ''
  let property = ''
  let value = ''
  parser.on('opentag', (tag) => {
    if (tag.name === 'item') item = tag.attributes['oor:path'] ?? ''
    if (tag.name === 'node') { family = tag.attributes['oor:name'] ?? ''; expect(tag.attributes['oor:op']).toBe('replace') }
    if (tag.name === 'prop') property = tag.attributes['oor:name'] ?? ''
    if (tag.name === 'value') value = ''
  })
  parser.on('text', (text) => { value += text })
  parser.on('closetag', (tag) => {
    if (tag.name !== 'value' || item !== '/org.openoffice.VCL/FontSubstitutions/en') return
    expect(property).toBe('SubstFonts')
    expect(families.has(family), `Duplicate VCL font record: ${family}`).toBe(false)
    families.set(family, value)
  })
  parser.write(xml).close()
  return families
}

/**
 * Stage a native engine whose helper is a Node script, so success and every
 * transport failure run on any host without a built LibreOffice.
 * @param helper - Script source the executable runs.
 * @returns the engine installation and its private profile directory.
 */
async function helperEngine(root: string, helper: string): Promise<{ engine: NativeEngine; profile: string }> {
  const directory = join(root, 'native')
  await mkdir(join(directory, 'program'), { recursive: true })
  const executable = join(directory, 'helper.cjs')
  await writeFile(executable, helper, { mode: 0o700 })
  const profile = join(root, 'profile')
  await mkdir(profile, { recursive: true })
  return { engine: { backend: 'native', root: directory, programDirectory: join(directory, 'program'), executable }, profile }
}

/** Helper source that answers one JSON line and optionally writes an output file. */
function helperScript(body: string): string {
  return body
}

const readArguments = 'const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => value.startsWith("--") ? [...pairs, [value, all[index + 1]]] : pairs, []));\n'

describe('native font profiles', () => {
  it('preserves XML-sensitive family names in private files', async () => {
    await withTemporaryDirectory(async (root) => {
      await prepareNativeFontProfile(root, [{ family: 'Ａ & "Font" <漢>', substitute: "B & 'Text' <字>" }])
      const path = join(root, 'user/registrymodifications.xcu')
      expect(substitutions(await readFile(path, 'utf8'))).toEqual(new Map([['afont漢', "B & 'Text' <字>"]]))
      if (process.platform !== 'win32') {
        expect((await stat(path)).mode & 0o777).toBe(0o600)
        expect((await stat(join(root, 'user'))).mode & 0o777).toBe(0o700)
      }
    })
  })

  it('follows engine metric search names and keeps explicit family choices', async () => {
    await withTemporaryDirectory(async (root) => {
      await prepareNativeFontProfile(root, [
        { family: 'Calibri', substitute: 'Arial' }, { family: 'Carlito', substitute: 'Courier New' },
        { family: 'BundesSerif Office', substitute: 'Times New Roman' },
        { family: '微软雅黑', substitute: 'PingFang SC' },
      ])
      expect(substitutions(await readFile(join(root, 'user/registrymodifications.xcu'), 'utf8'))).toEqual(new Map([
        ['calibri', 'Arial'], ['carlito', 'Courier New'], ['bundesserifoffice', 'Times New Roman'],
        ['microsoftyahei', 'PingFang SC'],
        ['cambria', 'Times New Roman'], ['caladea', 'Times New Roman'],
      ]))
    })
  })

  it('retains native canonical keys for common Chinese families', async () => {
    await withTemporaryDirectory(async (root) => {
      const names = ['微软雅黑', '宋体', '新宋体', '黑体', '楷体', '仿宋']
      await prepareNativeFontProfile(root, names.map(family => ({ family, substitute: 'Songti SC' })))
      const records = substitutions(await readFile(join(root, 'user/registrymodifications.xcu'), 'utf8'))
      expect([...records.keys()]).toEqual(['microsoftyahei', 'simsun', 'nsimsun', 'simhei', 'simkai', '仿宋'])
      expect([...records.values()].every(value => value === 'Songti SC')).toBe(true)
    })
  })

  it('empty choices create a headless profile and existing profiles are never overwritten', async () => {
    await withTemporaryDirectory(async (root) => {
      await prepareNativeFontProfile(root, [])
      expect((await stat(join(root, 'user'))).isDirectory()).toBe(true)
      const path = join(root, 'user/registrymodifications.xcu')
      const before = await readFile(path)
      expect(before.toString()).toContain('WarnActiveSheet')
      expect(before.toString()).toContain('<value>false</value>')
      await expect(prepareNativeFontProfile(root, [{ family: 'Missing Font', substitute: 'Courier New' }]))
        .rejects.toMatchObject({ code: 'EEXIST' })
      expect(await readFile(path)).toEqual(before)
    })
  })
})

describe('native helper environment', () => {
  it('excludes credentials and inherited loader overrides', () => {
    expect(nativeEnvironment('/private/profile', '/installed/program',
      { PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/real/home', DEEPSEEK_API_KEY: 'fixture', OPENAI_API_KEY: 'fixture', NODE_OPTIONS: '--inspect', DYLD_INSERT_LIBRARIES: '/fixture' },
      'darwin')).toEqual({
      PATH: '/usr/bin', LANG: 'en_US.UTF-8', HOME: '/private/profile', USERPROFILE: '/private/profile',
      TMPDIR: '/private/profile', TMP: '/private/profile', TEMP: '/private/profile',
    })
  })

  it('Linux helpers search only the selected package directory before system libraries', () => {
    const programDirectory = '/installed kit/program'
    const source = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/outside:/other', LD_PRELOAD: '/outside/injected.so' }
    expect(nativeEnvironment('/private/profile', programDirectory, source, 'linux').LD_LIBRARY_PATH).toBe(programDirectory)
    expect(nativeEnvironment('/private/profile', programDirectory, source, 'linux').LD_PRELOAD).toBeUndefined()
    for (const platform of ['darwin', 'win32'] as const) {
      const env = nativeEnvironment('/private/profile', programDirectory, source, platform)
      expect(env.LD_LIBRARY_PATH).toBeUndefined()
      expect(env.LD_PRELOAD).toBeUndefined()
      expect(env.PATH).toBe(source.PATH)
    }
    expect(source.LD_LIBRARY_PATH).toBe('/outside:/other')
  })
})

describe('native helper transport', () => {
  const options = resolveOptions({ fontDirectories: [], timeoutMs: 30_000 })

  it('runs the helper with bounded arguments and waits for its response', async () => {
    await withTemporaryDirectory(async (root) => {
      const output = join(root, 'document.pdf')
      const substitutionsArgument: FontSubstitution[] = [{ family: 'Calibri', substitute: 'Carlito' }]
      const { engine, profile } = await helperEngine(join(root, 'arguments'), helperScript(`${readArguments}
const fs = require('node:fs');
fs.writeFileSync(args['--output-path'], '%PDF-fixture');
fs.writeFileSync(${JSON.stringify(join(root, 'arguments.json'))}, JSON.stringify(args));
console.log(JSON.stringify({ ok: true }));\n`))
      await runNative(engine, options, join(root, 'input.docx'), output, profile, [], substitutionsArgument, new AbortController().signal, { format: 'csv', recalculate: false, sheet: 'Summary 中文' })
      expect(await readFile(output, 'utf8')).toBe('%PDF-fixture')
      const recorded = JSON.parse(await readFile(join(root, 'arguments.json'), 'utf8')) as string[]
      expect(recorded).toMatchObject({ '--format': 'csv', '--recalculate': 'false', '--sheet': 'Summary 中文' })
      expect(Object.keys(recorded)).toContain('--program-directory')
      expect(Object.values(recorded)).toContain(String(options.maxOutputBytes))
      expect(Object.values(recorded)).toContain(String(options.maxImageResolution))
      expect(await readFile(join(profile, 'user/registrymodifications.xcu'), 'utf8')).toContain('Carlito')
    })
  })

  it('reports an unparseable, oversized, or failed helper response', async () => {
    await withTemporaryDirectory(async (root) => {
      const output = join(root, 'document.pdf')
      const cases = [
        { helper: helperScript('console.log("not json");\n'), message: /invalid response/ },
        { helper: helperScript('console.log("x".repeat(70000));\nsetTimeout(() => {}, 5000);\n'), message: /exceeded its response limit/ },
        { helper: helperScript('console.log(JSON.stringify({ ok: false, error: "fixture conversion failure" }));\nprocess.exitCode = 2;\n'), message: /fixture conversion failure/ },
        { helper: helperScript('console.log(JSON.stringify({ ok: true }));\nprocess.exitCode = 3;\n'), message: /native conversion failed/ },
      ]
      for (const [index, { helper, message }] of cases.entries()) {
        const { engine, profile } = await helperEngine(join(root, `case-${index}`), helper)
        await expect(runNative(engine, options, join(root, 'input.docx'), output, profile, [], [], new AbortController().signal, { format: 'pdf', recalculate: false }))
          .rejects.toThrow(message)
      }
    })
  })

  it('reports a helper killed by its output file-size limit', async () => {
    await withTemporaryDirectory(async (root) => {
      // Node ignores SIGXFSZ and Windows cannot deliver it. Translate the completed
      // child's exit observation while retaining real process IO and teardown.
      const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
      vi.mocked(spawn).mockImplementationOnce((file, args, options) => {
        const child = actual.spawn(process.execPath, [file, ...args], options)
        const emit = child.emit.bind(child)
        child.emit = ((event: string | symbol, ...values: unknown[]) =>
          event === 'close' ? emit(event, null, 'SIGXFSZ') : emit(event, ...values)) as typeof child.emit
        return child
      })
      const { engine, profile } = await helperEngine(root, 'process.exitCode = 1\n')
      await expect(runNative(engine, options, join(root, 'input.docx'), join(root, 'out.pdf'), profile, [], [], new AbortController().signal, { format: 'pdf', recalculate: false }))
        .rejects.toMatchObject({ code: 'output-too-large' })
    })
  })

  it('reports a helper that cannot start', async () => {
    await withTemporaryDirectory(async (root) => {
      await mkdir(join(root, 'profile'))
      const engine: NativeEngine = { backend: 'native', root, programDirectory: root, executable: join(root, 'absent-helper') }
      await expect(runNative(engine, options, join(root, 'input.docx'), join(root, 'out.pdf'), join(root, 'profile'), [], [], new AbortController().signal, { format: 'pdf', recalculate: false }))
        .rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('kills the helper and rejects with the caller reason on cancellation', async () => {
    await withTemporaryDirectory(async (root) => {
      const { engine, profile } = await helperEngine(root, helperScript('setInterval(() => {}, 1000);\n'))
      const controller = new AbortController()
      const started = runNative(engine, options, join(root, 'input.docx'), join(root, 'out.pdf'), profile, [],
        [{ family: 'Calibri', substitute: 'Carlito' }], controller.signal, { format: 'pdf', recalculate: false })
      controller.abort(new Error('caller stopped the helper'))
      await expect(started).rejects.toThrow(/caller stopped the helper/)
      const aborted = new AbortController()
      aborted.abort(new Error('already stopped'))
      await expect(runNative(engine, options, join(root, 'input.docx'), join(root, 'out.pdf'), profile, [], [], aborted.signal, { format: 'pdf', recalculate: false }))
        .rejects.toThrow(/already stopped/)
      const duringProfile = new AbortController()
      const separate = await helperEngine(join(root, 'during-profile'), helperScript('setInterval(() => {}, 1000);\n'))
      queueMicrotask(() => { duringProfile.abort(new Error('stopped during profile')) })
      await expect(runNative(separate.engine, options, join(root, 'input.docx'), join(root, 'out.pdf'), separate.profile, [],
        [{ family: 'Calibri', substitute: 'Carlito' }], duringProfile.signal, { format: 'pdf', recalculate: false }))
        .rejects.toThrow(/stopped during profile/)
    })
  })

  it('kills a running helper on cancellation and forwards its diagnostics', async () => {
    await withTemporaryDirectory(async (root) => {
      const marker = join(root, 'started')
      const { engine, profile } = await helperEngine(root, helperScript(`process.stderr.write('helper diagnostic\\n');
require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');
setInterval(() => {}, 1000);\n`))
      const controller = new AbortController()
      const started = runNative(engine, options, join(root, 'input.docx'), join(root, 'out.pdf'), profile, [], [], controller.signal, { format: 'pdf', recalculate: false })
      for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt++) await new Promise(resolve => setTimeout(resolve, 20))
      expect(existsSync(marker)).toBe(true)
      controller.abort(new Error('helper stopped while running'))
      await expect(started).rejects.toThrow(/helper stopped while running/)
    })
  })

  it('passes installed font files to the helper', async () => {
    await withTemporaryDirectory(async (root) => {
      const fontFile = join(root, 'font.ttf')
      writeFileSync(fontFile, 'font bytes')
      const { engine, profile } = await helperEngine(root, helperScript('console.log(JSON.stringify({ ok: true }));\n'))
      await runNative(engine, options, join(root, 'input.docx'), join(root, 'out.pdf'), profile, [fontFile], [], new AbortController().signal, { format: 'pdf', recalculate: false })
    })
  })
})
