/** Observe both legacy and content-control checkbox state after a primary click. */
import { open, pixelDifference, strFromU8 } from './runtime.mjs';
import { formCheckboxFixture, contentControlFixture } from './form-fixtures.mjs';
const kind = process.argv[2] ?? 'legacy';
const action = process.argv[3] ?? 'click';
const r = await open(kind === 'legacy' ? formCheckboxFixture() : contentControlFixture(), 'docx');
try {
  await r.operation({ type: 'viewport', rectangle: { x: 0, y: 0, width: 960, height: 720 }, scale: 1 });
  const before = await r.paint(816, 720);
  const [x, y] = kind === 'legacy' ? [120, 139] : [103, 104];
  if (action === 'click') await r.click(x, y);
  else if (action !== 'none') throw Error('Unknown action');
  const undo = r.query('.uno:Undo');
  await r.click(700, 600);
  const after = await r.paint(816, 720);
  const xml = strFromU8(r.exportFiles()['word/document.xml']);
  console.log(JSON.stringify({ kind, action, changedPixels: pixelDifference(before, after), undo,
    fields: [...xml.matchAll(/<(?:w:ffData|w:checked|w14:checked)[^>]*>/g)].map(match => match[0]), failures: r.failures }));
} finally { await r.close(); }
