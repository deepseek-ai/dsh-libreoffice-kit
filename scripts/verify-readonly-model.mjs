/** Qualify model-preserving pointer gestures in the exact installed WASM candidate. */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { root } from './platform-matrix.mjs';

/** Fixed gestures include complete press/move/release sequences and an unchanged control. */
export const readonlyCases = [
  ...['shape', 'textbox', 'connector'].map(kind => ['ppt', kind, 'resize']),
  ['ppt', 'roundrect', 'adjust'], ['ppt', 'group', 'group-deep-resize'],
  ['ppt', 'shape', 'ctrl-resize'], ['ppt', 'shape', 'shift-resize'],
  ['ppt', 'picture', 'resize'], ['ppt', 'shape', 'ctrl-drag'],
  ['ppt', 'shape', 'arrow'], ['ppt', 'textbox', 'double-arrow'],
  ...['shape', 'textbox', 'connector'].map(kind => ['calc', kind, 'resize']),
  ['calc', 'roundrect', 'adjust'], ['calc', 'shape', 'move'],
  ...['row', 'column', 'corner'].map(action => ['table', action]),
  ['form', 'legacy', 'click'], ['form', 'sdt', 'click'],
];

function model(result) {
  return Object.fromEntries(['xfrm', 'anchors', 'adjustments', 'names', 'rows', 'columns', 'fields', 'copied']
    .filter(key => key in result).map(key => [key, result[key]]));
}

/** Verify every required gesture and its independently opened unchanged control. */
export function verifyReadonlyModel(receipt) {
  assert.equal(receipt?.schemaVersion, 1);
  assert.equal(receipt?.kind, 'native-readonly-model');
  assert.equal(receipt?.passed, true);
  assert.deepEqual(receipt.cases?.map(item => item.id), readonlyCases.map(parts => parts.join('/')));
  for (const item of receipt.cases) {
    assert.equal(item.modelUnchanged, true, item.id);
    assert.equal(item.undoUnchanged, true, item.id);
    assert.equal(item.changedPixels, 0, item.id);
  }
  return receipt;
}

/** Execute each model in a fresh child, avoiding LibreOffice's process-global state. */
export function qualifyReadonlyModel({ kitDirectory, wasmDirectory, fontPath }) {
  const loader = createRequire(import.meta.url).resolve('tsx/esm');
  const env = { ...process.env, READONLY_KIT_DIRECTORY: kitDirectory,
    READONLY_WASM_DIRECTORY: wasmDirectory, READONLY_FONT_PATH: fontPath };
  const run = (script, args) => {
    const output = execFileSync(process.execPath, ['--import', loader, join(root, 'test/readonly', `${script}.mjs`), ...args],
      { env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const result = JSON.parse(output.split('\n').findLast(line => line.startsWith('{')));
    assert.deepEqual(result.failures, []);
    const required = script === 'form' ? ['fields'] : script === 'table' ? ['xfrm', 'rows', 'columns'] : ['xfrm'];
    for (const field of required) assert(result[field]?.length > 0, `${script}: missing model observation ${field}`);
    return result;
  };
  const controls = new Map(), cases = [];
  for (const [script, ...args] of readonlyCases) {
    const id = [script, ...args].join('/');
    const controlArgs = script === 'table' ? ['click'] : [args[0], script === 'form' ? 'none' : 'click'];
    const controlKey = [script, ...controlArgs].join('/');
    let control = controls.get(controlKey);
    if (!control) { control = run(script, controlArgs); controls.set(controlKey, control); }
    const result = run(script, args);
    assert.deepEqual(model(result), model(control), `${id}: document model changed`);
    const undo = value => typeof value === 'string' ? JSON.parse(value) : value;
    assert.deepEqual(undo(result.undo), undo(control.undo), `${id}: undo state changed`);
    assert.equal(result.changedPixels, 0, `${id}: document pixels changed`);
    cases.push({ id, modelUnchanged: true, undoUnchanged: true, changedPixels: result.changedPixels });
    console.log(`Readonly model: ${id}`);
  }
  return verifyReadonlyModel({ schemaVersion: 1, kind: 'native-readonly-model', passed: true, cases });
}
