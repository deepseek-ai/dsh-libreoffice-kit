/** Host font metadata snapshots and conversion-local glyph matching over original files. */
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, join, posix, win32 } from 'node:path';
import { create } from 'fontkit';
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.dfont']);
const VCL_WEIGHTS = [400, 100, 200, 300, 350, 400, 500, 600, 700, 800, 900];
const GENERIC_FAMILIES = new Set(['serif', 'sansserif', 'monospace', 'cursive', 'fantasy', 'systemui', 'symbol']);
function absent(error) {
    return error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(String(error.code));
}
export function normalize(value) {
    return value.normalize('NFKC').toLowerCase().replaceAll(/[\s_-]/g, '');
}
/**
 * Discover conventional system and per-user font roots without native helpers.
 * @param platform - Host operating system.
 * @param home - Host user home used to locate per-user font directories.
 * @param env - Host environment containing Windows and XDG directory overrides.
 * @returns candidate directories; missing platform directories are ignored during indexing.
 */
export function systemFontDirectories(platform = process.platform, home = homedir(), env = process.env) {
    if (platform === 'win32') {
        return [win32.join(env.SystemRoot ?? 'C:\\Windows', 'Fonts'),
            win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
    }
    if (platform === 'darwin') {
        const assets = '/System/Library/AssetsV2';
        let entries = [];
        try {
            entries = readdirSync(assets);
        }
        catch (error) {
            // Font assets may be unavailable or protected on an otherwise supported macOS installation.
            if (!absent(error))
                throw error;
        }
        return ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library/Fonts'),
            ...entries.filter(name => /^com_apple_MobileAsset_Font\d*$/.test(name)).sort().map(name => join(assets, name))];
    }
    const shared = (env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':').filter(Boolean);
    return [...new Set([...shared.map(path => posix.join(path, 'fonts')), posix.join(home, '.fonts'),
            posix.join(env.XDG_DATA_HOME ?? posix.join(home, '.local/share'), 'fonts')])];
}
function fontPaths(directories, maxFiles) {
    const pending = [...directories].reverse();
    const visited = new Set();
    const paths = [];
    for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
        let canonical;
        let status;
        try {
            canonical = realpathSync(path);
            status = statSync(canonical);
        }
        catch (error) {
            // Optional font directories, dangling font links, and protected assets are not usable sources.
            if (absent(error))
                continue;
            throw error;
        }
        if (visited.has(canonical))
            continue;
        visited.add(canonical);
        if (status.isDirectory()) {
            let names;
            try {
                names = readdirSync(canonical);
            }
            catch (error) {
                // Directory access can change after the successful stat.
                if (absent(error))
                    continue;
                throw error;
            }
            pending.push(...names.sort().reverse().map(name => join(canonical, name)));
        }
        else if (status.isFile() && FONT_EXTENSIONS.has(extname(canonical).toLowerCase())) {
            if (paths.length >= maxFiles)
                throw new Error('The system font catalog exceeds maxFontFiles.');
            paths.push(canonical);
        }
    }
    return paths;
}
function ranges(font) {
    const points = font.characterSet.filter(point => font.hasGlyphForCodePoint(point)).sort((left, right) => left - right);
    const result = [];
    for (const point of points) {
        const last = result.at(-1);
        if (last !== undefined && point <= last[1] + 1)
            last[1] = Math.max(last[1], point);
        else
            result.push([point, point]);
    }
    return result;
}
function covers(face, points, signal) {
    if (points.length === 0)
        return [];
    if (face.coverage === undefined) {
        const parsed = create(readFont(face));
        const font = 'fonts' in parsed ? parsed.fonts[face.faceIndex] : parsed;
        if (font === undefined || font.postscriptName !== face.postscriptName)
            throw new Error('The indexed font face is no longer available; recreate the converter.');
        try {
            face.coverage = ranges(font);
        }
        catch {
            // Lazy glyph decoding can reject damaged tables after the same font's metadata was accepted.
            face.coverage = [];
        }
    }
    const coverage = face.coverage;
    return points.filter(point => coverage.some(([first, last]) => point >= first && point <= last));
}
function inspect(path, maxBytes) {
    let status;
    let bytes;
    try {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
            status = fstatSync(fd);
            if (!status.isFile() || status.size > maxBytes)
                return [];
            bytes = Buffer.alloc(status.size);
            let offset = 0;
            while (offset < bytes.length) {
                const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
                if (count === 0)
                    throw new Error('A system font was truncated while indexing; reload the font service.');
                offset += count;
            }
            const after = fstatSync(fd);
            if (bytes.length !== status.size || after.size !== status.size
                || after.mtimeMs !== status.mtimeMs || after.ctimeMs !== status.ctimeMs) {
                throw new Error('A system font changed while indexing; reload the font service.');
            }
        }
        finally {
            closeSync(fd);
        }
    }
    catch (error) {
        // Installed font files may disappear or become protected between directory enumeration and reading.
        if (absent(error))
            return [];
        throw error;
    }
    let faces;
    try {
        const parsed = create(bytes);
        const fonts = 'fonts' in parsed ? parsed.fonts : [parsed];
        faces = fonts.map((font, faceIndex) => {
            const decoded = font;
            const names = ['fontFamily', 'preferredFamily', 'fullName', 'postscriptName']
                .flatMap(key => Object.values(decoded.name?.records[key] ?? {}))
                .filter((name) => typeof name === 'string');
            const aliases = [...new Set([...names, font.familyName, font.fullName, font.postscriptName].filter(Boolean).map(normalize))];
            return {
                path, size: status.size, mtimeMs: status.mtimeMs, ctimeMs: status.ctimeMs,
                dev: status.dev, ino: status.ino, faceIndex,
                family: font.familyName, style: font.subfamilyName, aliases,
                weight: decoded['OS/2']?.usWeightClass ?? 400, width: decoded['OS/2']?.usWidthClass ?? 5,
                italic: font.italicAngle !== 0, fixed: Boolean(decoded.post?.isFixedPitch), postscriptName: font.postscriptName,
            };
        });
    }
    catch {
        // fontkit rejects unsupported or damaged font tables; other installed files can still satisfy the request.
        return [];
    }
    return faces;
}
function regionalPriority(face, language) {
    const locale = language.toLowerCase();
    const preferred = locale.startsWith('ja') ? ['jp'] : locale.startsWith('ko') ? ['kr']
        : locale.startsWith('zh') ? (/hant|tw|hk|mo/.test(locale) ? ['tc', 'hk'] : ['sc']) : [];
    if (preferred.length === 0)
        return 0;
    const name = `${face.family} ${face.postscriptName} ${basename(face.path)}`.toLowerCase();
    const region = name.match(/(?:cjk|[\s_-])(sc|tc|jp|kr|hk)(?=[\s_.-]|$)/)?.[1];
    return region === undefined ? 1 : preferred.includes(region) ? 0 : 2;
}
/**
 * Snapshot eligible local font metadata without retaining font bytes or decoding glyph coverage.
 * @param options - Host font roots and physical file limits.
 * @returns metadata reused for the converter lifetime; recreate it after changing installed fonts.
 */
export function indexSystemFonts(options) {
    return fontPaths(options.directories, options.maxFiles).flatMap(path => inspect(path, options.maxFileBytes));
}
/** Conversion-local glyph coverage over the converter's first metadata snapshot. */
export class SystemFontCatalog {
    options;
    faces;
    /**
     * @param options - Host metadata snapshot and fallback families.
     */
    constructor(options) {
        this.options = options;
        this.faces = options.faces.map(face => ({ ...face }));
    }
    /**
     * Find installed faces covering the requested family or missing characters.
     * Exact families precede configured alternatives, symbol families for missing symbols, generic families, then other glyph-covering faces.
     * @param request - VCL family/style attributes and Unicode scalars missing from its current font.
     * @param signal - cancellation checked between synchronous font reads.
     * @returns selected physical files, deduplicated across collection faces; absent glyphs remain unresolved.
     * @throws if an indexed font changes or cannot be read during glyph matching.
     */
    match(request, signal) {
        signal.throwIfAborted();
        const requested = request.family.split(';').map(family => family.trim()).filter(Boolean);
        const original = requested.map(normalize);
        const primary = requested[0];
        let missingFamily;
        if (primary !== undefined && !GENERIC_FAMILIES.has(normalize(primary))
            && !this.faces.some(face => face.aliases.includes(normalize(primary)))) {
            missingFamily = primary;
        }
        const families = [...original];
        for (const group of this.options.fallbackFamilies) {
            const normalized = group.map(normalize);
            if (original.some(family => normalized.includes(family)))
                families.push(...normalized);
        }
        const generic = original.includes('serif') ? 'serif'
            : request.pitch === 1 || original.includes('monospace') ? 'monospace' : 'sansserif';
        const fallbackKinds = request.codePoints.some(point => /\p{Symbol}/u.test(String.fromCodePoint(point))) ? ['symbol', generic] : [generic];
        for (const kind of fallbackKinds) {
            for (const group of this.options.fallbackFamilies) {
                const normalized = group.map(normalize);
                if (normalized.includes(kind))
                    families.push(...normalized);
            }
        }
        const priority = [...new Set(families)];
        const missing = new Set(request.codePoints);
        const ranked = this.faces.map((face) => {
            const rank = priority.findIndex(family => face.aliases.includes(family));
            const region = regionalPriority(face, request.language);
            const style = (request.style && normalize(request.style) === normalize(face.style) ? -1 : 0)
                + (request.italic === 3 || (request.italic !== 0) === face.italic ? 0 : 100)
                + (request.pitch === 0 || (request.pitch === 1) === face.fixed ? 0 : 50)
                + Math.abs((VCL_WEIGHTS[request.weight] ?? 400) - face.weight) / 100
                + (request.width === 0 ? 0 : Math.abs(request.width - face.width));
            return { face, rank: rank < 0 ? priority.length : rank, region, style };
        }).sort((left, right) => left.rank - right.rank || left.region - right.region || left.style - right.style
            || left.face.path.localeCompare(right.face.path, 'en') || left.face.faceIndex - right.face.faceIndex);
        const selected = [];
        const files = new Set();
        for (const { face } of ranked) {
            signal.throwIfAborted();
            const covered = covers(face, [...missing], signal);
            if (missing.size > 0 && covered.length === 0)
                continue;
            if (!files.has(face.path)) {
                selected.push(face);
                files.add(face.path);
            }
            for (const point of covered)
                missing.delete(point);
            if (missing.size === 0)
                break;
        }
        return { fonts: selected, ...(missingFamily === undefined ? {} : { missingFamily }) };
    }
}
/** Read the unchanged indexed regular file; reject concurrent replacement or truncation. */
export function readFont(face) {
    const fd = openSync(face.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
        const before = fstatSync(fd);
        if (!before.isFile() || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== face[key]))
            throw new Error('An indexed font changed; recreate the converter.');
        const bytes = Buffer.alloc(face.size);
        for (let offset = 0; offset < bytes.length;) {
            const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
            if (!count)
                throw new Error('An indexed font was truncated.');
            offset += count;
        }
        const after = fstatSync(fd);
        if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => after[key] !== face[key]))
            throw new Error('An indexed font changed while reading.');
        return bytes;
    }
    finally {
        closeSync(fd);
    }
}
