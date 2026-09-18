/** Table handles must preserve both table cells and the containing frame. */
import { open, strFromU8, pixelDifference } from './runtime.mjs';
import { fixtureBytes } from './fixtures.mjs';
const action = process.argv[2] ?? 'row';
const r = await open(fixtureBytes('pptx-table'), 'pptx');
try {
  await r.operation({ type: 'viewport', rectangle: { x: 0, y: 0, width: 960, height: 720 }, scale: 1 });
  const before = await r.paint();
  await r.click(480, 240);
  const selectionBefore = r.reader.state.graphicSelection;
  if (action === 'row') await r.drag(400, 288, 0, 60);
  else if (action === 'column') await r.drag(352, 240, 80, 0);
  else if (action === 'corner') await r.drag(864, 384, 36, 80);
  else if (action !== 'click') throw Error('Unknown action');
  const selectionAfter = r.reader.state.graphicSelection, undo = r.query('.uno:Undo');
  await r.click(900, 690);
  const after = await r.paint();
  const xml = strFromU8(r.exportFiles()['ppt/slides/slide1.xml']);
  console.log(JSON.stringify({ kind: 'table', action, selectionBefore, selectionAfter,
    changedPixels: pixelDifference(before, after), undo,
    xfrm: [...xml.matchAll(/<p:xfrm[\s\S]*?<\/p:xfrm>/g)].map(match => match[0]),
    rows: [...xml.matchAll(/<a:tr h="([^"]+)"/g)].map(match => match[1]),
    columns: [...xml.matchAll(/<a:gridCol w="([^"]+)"/g)].map(match => match[1]), failures: r.failures }));
} finally { await r.close(); }
