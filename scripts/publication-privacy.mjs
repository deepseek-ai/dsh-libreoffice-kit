/** Inspect the bytes to be published. Diagnostics never include matched values. */
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { gunzipSync, inflateRawSync } from 'node:zlib';

const maximumBytes = 1024 * 1024 * 1024;

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid ${label}; contents redacted`); }
}

export function privacyOptions(environment = process.env) {
  const secrets = Object.entries(environment).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(key)
    && !['LIBREOFFICE_KIT_AUDIT_SECRETS_FILE', 'LIBREOFFICE_KIT_PRIVATE_IDENTIFIERS'].includes(key) && typeof value === 'string' && value.length >= 16).map(([, value]) => value);
  const file = environment.LIBREOFFICE_KIT_AUDIT_SECRETS_FILE;
  if (file) {
    if (!existsSync(file)) throw new Error('The configured audit secrets file is missing');
    const text = readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w.-]*\s*[=:]\s*["']?([^\r\n]*?)\s*$/i);
      if (match) {
        const value = match[1].replace(/["',]+$/, '');
        if (value.length >= 12) secrets.push(value);
      }
    }
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && typeof child === 'string' && child.length >= 12) secrets.push(child);
        else visit(child);
      }
    };
    try { visit(JSON.parse(text)); } catch { /* Shell assignment files are also supported. */ }
  }
  const identifiers = parseJson(environment.LIBREOFFICE_KIT_PRIVATE_IDENTIFIERS ?? '[]', 'private identifier configuration');
  if (!Array.isArray(identifiers) || identifiers.some(value => typeof value !== 'string' || value.length < 4))
    throw new Error('Private identifiers must be a JSON array of strings of at least four characters');
  const user = userInfo().username;
  if (user.length >= 4 && !['root', 'runner', 'build', 'admin', 'administrator'].includes(user.toLowerCase())) identifiers.push(user);
  return { secrets: [...new Set(secrets)], identifiers: [...new Set(identifiers)] };
}

function fail(location, kind) {
  // A malformed archive can put sensitive text in a filename too.
  const safe = /^[A-Za-z0-9_./!@+ -]{1,240}$/.test(location) && !/(?:sk-|npm_|ghp_|github_pat_)/.test(location) ? location : 'archive entry';
  throw new Error(`Publication privacy check failed (${kind}) in ${safe}; matched value redacted`);
}

/** Scan bounded chunks, including UTF-16 paths and encoded known credentials. */
export function auditBytes(bytes, location, options = privacyOptions()) {
  const known = (options.secrets ?? []).filter(value => value.length >= 12).flatMap(value =>
    [Buffer.from(value), Buffer.from(value, 'utf16le'), Buffer.from(Buffer.from(value).toString('base64'))]);
  for (const value of known) if (bytes.includes(value)) fail(location, 'known credential');
  for (const value of options.identifiers ?? []) {
    if (bytes.includes(Buffer.from(value)) || bytes.includes(Buffer.from(value, 'utf16le'))) fail(location, 'private build identity');
  }
  const inspect = text => {
    if (/(?:\bsk-[A-Za-z0-9_-]{20,}|\bnpm_[A-Za-z0-9]{30,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|\bAKIA[A-Z0-9]{16})/.test(text)) fail(location, 'token');
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{32,}-----END /.test(text)) fail(location, 'private key');
    if (/https?:\/\/[^\s\x00/:"'<>]{1,80}:[^\s\x00/@"'<>]{3,200}@[a-z0-9.-]+\.[a-z]{2,}/i.test(text)) fail(location, 'authenticated URL');
    for (const match of text.matchAll(/(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])([A-Za-z0-9_.-]+)[\\/]/g)) {
      if (match[0].startsWith('/home/web_user/')) continue; // Emscripten's synthetic home.
      if (match[0].startsWith('/home/eric/') && location.endsWith('/schart/ui/steppedlinesdlg.ui')) continue; // Upstream Glade comment.
      fail(location, 'personal home path');
    }
    if (/(?:^|[\r\n])Vendor=(?!DeepSeek(?:\r?\n|$))[^\r\n]+/.test(text)
      || /oor:name="ooVendor"><value>(?!DeepSeek<)[^<]+<\/value>/.test(text)) fail(location, 'non-public vendor');
    if (/github\.com\/deepseek-harness\/deepseek-harness(?:\/|\b)/.test(text)) fail(location, 'internal application link');
  };
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    const chunk = bytes.subarray(offset, offset + 1024 * 1024 + 16384);
    const text = chunk.toString('latin1');
    inspect(text);
    // Locate ASCII UTF-16 strings at either alignment instead of decoding arbitrary binary words.
    for (const match of text.matchAll(/(?:[\x09\x0a\x0d\x20-\x7e]\x00){4,}/g)) inspect(match[0].replaceAll('\0', ''));
  }
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    if ((options.zipDepth ?? 0) >= 8) fail(location, 'nested ZIP limit');
    auditZip(bytes, location, { ...options, zipDepth: (options.zipDepth ?? 0) + 1 });
  }
}

function auditZip(bytes, location, options) {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, bytes.length - 65557)) fail(location, 'invalid ZIP resource');
  let cursor = bytes.readUInt32LE(end + 16);
  let total = 0;
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) fail(location, 'invalid ZIP index');
    const size = bytes.readUInt32LE(cursor + 24);
    total += size;
    if (total > maximumBytes || bytes.readUInt16LE(cursor + 8) & 1) fail(location, 'unsupported ZIP resource');
    const nameSize = bytes.readUInt16LE(cursor + 28);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize).toString();
    auditBytes(Buffer.from(name), `${location}!filename`, options);
    const local = bytes.readUInt32LE(cursor + 42);
    if (local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) fail(location, 'invalid ZIP member');
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const packed = bytes.subarray(start, start + bytes.readUInt32LE(cursor + 20));
    const method = bytes.readUInt16LE(cursor + 10);
    if (![0, 8].includes(method)) fail(location, 'unsupported ZIP compression');
    const data = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, size) });
    if (data.length !== size) fail(location, 'ZIP size mismatch');
    if (data.length) auditBytes(data, `${location}!${name}`, options);
    cursor += 46 + nameSize + bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
  }
}

/** Parse npm USTAR/PAX without extracting arbitrary filesystem paths. */
export function visitTar(bytes, visit) {
  let cursor = 0;
  let extended = {};
  const names = new Set();
  while (cursor + 512 <= bytes.length) {
    const header = bytes.subarray(cursor, cursor + 512);
    if (header.every(byte => byte === 0)) {
      if (bytes.subarray(cursor).some(byte => byte !== 0)) throw new Error('Unexpected bytes after tar terminator');
      return;
    }
    const field = (start, size) => header.subarray(start, start + size).toString().replace(/\0.*$/s, '');
    const number = (start, size) => {
      const text = field(start, size).trim();
      if (!/^[0-7]*$/.test(text)) throw new Error('Unsupported tar numeric field');
      return parseInt(text || '0', 8);
    };
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== number(148, 8)) throw new Error('Tar checksum mismatch');
    const size = number(124, 12);
    const data = bytes.subarray(cursor + 512, cursor + 512 + size);
    if (data.length !== size) throw new Error('Truncated tar entry');
    cursor += 512 + Math.ceil(size / 512) * 512;
    const type = field(156, 1) || '0';
    if (type === 'x') {
      let offset = 0;
      while (offset < data.length) {
        const space = data.indexOf(32, offset);
        const length = Number(data.subarray(offset, space).toString());
        if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > data.length) throw new Error('Invalid PAX record');
        const record = data.subarray(space + 1, offset + length - 1).toString();
        const equal = record.indexOf('=');
        if (equal < 1) throw new Error('Invalid PAX key');
        extended[record.slice(0, equal)] = record.slice(equal + 1);
        offset += length;
      }
      continue;
    }
    if (!['0', '5'].includes(type)) throw new Error('Unsupported tar entry type');
    const prefix = field(345, 155);
    const name = extended.path ?? `${prefix ? `${prefix}/` : ''}${field(0, 100)}`;
    if (names.has(name)) throw new Error('Duplicate tar entry');
    names.add(name);
    visit({ name, data, type, uid: number(108, 8), gid: number(116, 8), uname: field(265, 32), gname: field(297, 32), extended });
    extended = {};
  }
  throw new Error('Tar terminator missing');
}

export function auditNpmArchive(file, options = privacyOptions()) {
  const packed = readFileSync(file);
  if (packed[0] === 0x1f && packed[1] === 0x8b && (packed[3] & 0x1e)) fail('gzip header', 'extended metadata');
  const bytes = packed[0] === 0x1f && packed[1] === 0x8b ? gunzipSync(packed, { maxOutputLength: maximumBytes }) : packed;
  const files = new Map();
  visitTar(bytes, entry => {
    const { name, data, type, extended } = entry;
    auditBytes(Buffer.from(name), 'package filename', options);
    auditBytes(Buffer.from(JSON.stringify(extended)), 'tar extended metadata', options);
    if (extended.size !== undefined && Number(extended.size) !== data.length) throw new Error('PAX size differs from tar header');
    if (!name.startsWith('package/') || name.split('/').some(part => part === '..') || /[\\\x00-\x1f]/.test(name)) fail('archive', 'unsafe package path');
    if (entry.uid !== 0 || entry.gid !== 0 || entry.uname || entry.gname
      || Object.keys(extended).some(key => !['path', 'size', 'mtime'].includes(key))) fail(name, 'archive ownership or extended metadata');
    if (/(?:^|\/)(?:\._[^/]*|\.DS_Store|\.npmrc|\.env(?:\.[^/]*)?|\.git|\.dsh-dev-api|id_rsa|id_ed25519)(?:\/|$)/.test(name)) fail(name, 'private file');
    if (type === '0') {
      if (name !== 'package/assets/soffice.data') auditBytes(data, name, options);
      files.set(name, data);
    }
  });
  if (!files.has('package/package.json')) throw new Error('Archive has no package manifest');
  // The data image can contain compressed resources, so inspect indexed members too.
  if (files.has('package/assets/soffice.data')) {
    const data = files.get('package/assets/soffice.data');
    const metadata = parseJson(files.get('package/assets/soffice.data.js.metadata')?.toString() ?? '{}', 'WASM resource index');
    if (metadata.remote_package_size !== data.length || !Array.isArray(metadata.files)) throw new Error('Invalid WASM resource index');
    let cursor = 0;
    for (const item of metadata.files) {
      if (item.start !== cursor || !Number.isSafeInteger(item.end) || item.end < cursor || item.end > data.length) throw new Error('Invalid WASM resource range');
      auditBytes(data.subarray(cursor, item.end), `soffice.data!${item.filename}`, options);
      cursor = item.end;
    }
    if (cursor !== data.length) throw new Error('Incomplete WASM resource index');
  }
  return { files: files.size, manifest: parseJson(files.get('package/package.json').toString(), 'package manifest') };
}
