/** Curated fonts discovered from a user's Microsoft Office installation. */
import { readdirSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, posix, win32 } from 'node:path'
import { absent, normalize } from './fonts.ts'
import type { FontFace } from './fonts.ts'

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.dfont'])
const OFFICE_FONT_FILE = /^(?:aptos(?:[- ].*)?|arial(?:bd|bi|i)?|calibri(?:b|i|z|l|li)?|cambria(?:b|i|z)?|cour(?:bd|bi|i)?|deng(?:b|l)?|fangsong|kaiti|msjh(?:bd)?|msyh(?:bd|l)?|segoeui(?:b|i|z|l|li|sb|sbi|sl|sli)?|simhei|simsunb?|symbol|times(?:bd|bi|i)?|wingdings(?: [23])?|wingdng[23])\.(?:ttf|otf|ttc|otc)$/iu
const FAMILIES = new Set(['aptos', 'aptos display', 'aptos narrow', 'arial', 'calibri', 'calibri light', 'cambria',
  'cambria math', 'courier new', 'dengxian', 'fangsong', 'kaiti', 'microsoft jhenghei', 'microsoft jhenghei ui',
  'microsoft yahei', 'microsoft yahei ui', 'nsimsun', 'segoe ui', 'simhei', 'simsun', 'symbol', 'times new roman',
  'wingdings', 'wingdings 2', 'wingdings 3'].map(normalize))

/** @returns whether parsed font names belong to the curated Office compatibility set. */
export function officeFontFace(face: Pick<FontFace, 'aliases'>): boolean {
  return face.aliases.some(alias => FAMILIES.has(alias))
}

function directory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch (error) { if (absent(error)) return false; throw error }
}

function files(root: string, recursive: boolean, namesOnly = true): string[] {
  const pending = [root], result: string[] = []
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    let entries: Dirent[]
    try { entries = readdirSync(current, { withFileTypes: true }) } catch (error) { if (absent(error)) continue; throw error }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (entry.isDirectory()) { if (recursive && entry.name !== 'PreviewFont') pending.push(join(current, entry.name)) }
      else if (entry.isFile() && FONT_EXTENSIONS.has(extname(entry.name).toLowerCase())
        && (!namesOnly || OFFICE_FONT_FILE.test(entry.name))) result.push(join(current, entry.name))
    }
  }
  return result
}

/** Find compatibility font files without exposing their paths outside the font Worker. */
export function officeFontFiles(platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env,
  applicationRoots: readonly string[] = ['/Applications', posix.join(home, 'Applications')]): string[] {
  const bundled = platform === 'darwin'
    ? ['Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint'].flatMap(app => applicationRoots.map(root =>
        posix.join(root, `${app}.app/Contents/Resources/DFonts`))).find(directory)
    : platform === 'win32' ? [env.ProgramFiles, env['ProgramFiles(x86)']].filter((root): root is string => Boolean(root))
        .map(root => win32.join(root, 'Microsoft Office', 'root', 'vfs', 'Fonts', 'private')).find(directory) : undefined
  const cloud = platform === 'darwin' ? posix.join(home, 'Library/Group Containers/UBF8T346G9.Office/FontCache')
    : platform === 'win32' ? win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'Microsoft', 'FontCache') : undefined
  const ordered = [...(bundled === undefined ? [] : files(bundled, false).sort()),
    ...(cloud === undefined ? [] : files(cloud, true, false).sort((a, b) => b.localeCompare(a, 'en', { numeric: true })))]
  const unique = new Map<string, string>()
  for (const file of ordered) {
    const portable = file.replaceAll('\\', '/')
    const name = portable.slice(portable.lastIndexOf('/') + 1).toLowerCase()
    if (!unique.has(name)) unique.set(name, file)
  }
  return [...unique.values()]
}
