import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewFixture } from '../browser-preview-fixture.mjs';
export { previewFixture };

export const kit = resolve(process.env.READONLY_KIT_DIRECTORY);
export const assets = resolve(process.env.READONLY_WASM_DIRECTORY, 'assets');
const require = createRequire(`${kit}/package.json`);
export const { zipSync, unzipSync, strToU8, strFromU8 } = require('fflate');
const { memoryFontConfig } = await import(pathToFileURL(join(kit, 'lib/font-config.js')).href);

/** Each child owns one WASM instance; native process state is never shared between cases. */
export async function open(data, extension, { fontPath = process.env.READONLY_FONT_PATH } = {}) {
  const { OfficeEngine } = await import(pathToFileURL(join(kit, 'sources/browser/packages/browser/src/office-engine.ts')).href);
  const raw = readFileSync(`${assets}/soffice.data`), font = readFileSync(fontPath);
  let reader, module, office = 0, document = 0, idleSequence = 0;
  const callbacks = [], events = [], failures = [];
  const idleReplies = new Set();
  module = await require(`${assets}/soffice.cjs`)({
    noInitialRun: true, mainScriptUrlOrBlob: `${assets}/soffice.cjs`,
    locateFile: name => `${assets}/${basename(name) === 'soffice.wasm' ? 'dsh-office.wasm' : basename(name)}`,
    getPreloadedPackage: () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    dshResolveSystemFontFaces: () => [{ path: '/dsh-fonts/Arial.ttf', family: 'Arial' }],
    dshOnCallback(type, payload) {
      callbacks.push({ type, payload });
      if (type === 16) { const result = JSON.parse(payload); if (result.idleID) idleReplies.add(result.idleID); }
      reader?.callback(type, payload);
    },
    preRun: [m => {
      for (const path of ['/dsh/profile', '/dsh/font-cache', '/dsh-fonts']) m.FS.mkdirTree(path);
      m.FS.writeFile('/dsh-fonts/Arial.ttf', font);
      m.FS.writeFile('/dsh/fonts.conf', strToU8(memoryFontConfig([['Arial']], [])));
      Object.assign(m.ENV, { HOME: '/dsh/profile', TMPDIR: '/tmp', FONTCONFIG_FILE: '/dsh/fonts.conf', LOK_HOST_ALLOWLIST: '^$' });
    }], print() {}, printErr() {},
  });
  const call = (name, args = []) => module.ccall(name, 'number', args.map(value => typeof value === 'string' ? 'string' : 'number'), args);
  const text = (name, args) => { const pointer = call(name, args); if (!pointer) return null;
    try { return module.UTF8ToString(pointer); } finally { call('free', [pointer]); } };
  const close = async () => {
    reader?.stop();
    try { if (document) call('dsh_lok_document_destroy', [document]); if (office) call('dsh_lok_destroy', [office]); }
    finally { module.PThread.terminateAllThreads(); }
  };
  try {
    module.FS.writeFile(`/dsh/input.${extension}`, data);
    office = call('dsh_lok_initialize', ['/instdir/program', 'file:///dsh/profile']);
    document = call('dsh_lok_document_load', [office, `file:///dsh/input.${extension}`, 'ReadOnly=true,EnableMacrosExecution=false']);
    if (!document || !call('dsh_lok_document_initialize_rendering', [document])) throw Error(text('dsh_lok_error', [office]));
    reader = new OfficeEngine(module, document, extension, event => events.push(event), failure => failures.push(String(failure)));
    await reader.start();
    const idle = async () => {
      const id = `readonly-audit-${++idleSequence}`;
      call('dsh_lok_document_command', [document, '.uno:ReportWhenIdle', JSON.stringify({ idleID: { type: 'string', value: id } })]);
      const deadline = performance.now() + 5000;
      while (!idleReplies.has(id)) {
        call('dsh_lok_pump');
        if (performance.now() > deadline) throw Error('Native idle timed out');
        await new Promise(resolve => setTimeout(resolve, 1));
      }
      reader.flush();
    };
    const operation = async op => { const result = await reader.operation(op); await idle(); return result; };
    const pointer = (action, x, y, modifiers = 0, clicks = 1, buttons = 1) => operation({ type: 'pointer', event: { action, x, y, modifiers, clicks, buttons } });
    const click = async (x, y, modifiers = 0, clicks = 1) => { await pointer('down', x, y, modifiers, clicks); await pointer('up', x, y, modifiers, clicks); };
    const drag = async (x, y, dx, dy, modifiers = 0) => { await pointer('down', x, y, modifiers); await pointer('move', x + dx / 2, y + dy / 2, modifiers); await pointer('move', x + dx, y + dy, modifiers); await pointer('up', x + dx, y + dy, modifiers); };
    const copy = async () => (await operation({ type: 'copy' })).text;
    const query = command => text('dsh_lok_document_command_values', [document, command]);
    const paint = async (width = 960, height = 720, x = 0, y = 0, scale = 1) => {
      await idle();
      return reader.render({ part: reader.state.part, x, y, width, height, scale });
    };
    // Diagnostic-only observation through the CLI export ABI. Export last: export
    // itself can add native undo entries and must never precede the tested gesture.
    const exportFiles = () => {
      const path = `/dsh/result.${extension}`;
      if (!call('dsh_lok_document_export', [office, document, `file://${path}`, extension, '', 0, ''])) throw Error(text('dsh_lok_error', [office]));
      return unzipSync(module.FS.readFile(path));
    };
    await idle();
    return { reader, module, office, document, events, callbacks, failures, call, text, idle, operation,
      pointer, click, drag, copy, query, paint, exportFiles, close };
  } catch (error) { await close(); throw error; }
}

export function pixelDifference(a, b) {
  if (a.rgba.length !== b.rgba.length) return { dimensionsChanged: true };
  let changed = 0;
  for (let index = 0; index < a.rgba.length; index += 4)
    if (a.rgba[index] !== b.rgba[index] || a.rgba[index + 1] !== b.rgba[index + 1] || a.rgba[index + 2] !== b.rgba[index + 2] || a.rgba[index + 3] !== b.rgba[index + 3]) changed++;
  return changed;
}
