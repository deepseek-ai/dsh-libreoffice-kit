/** Run one isolated native readonly gesture and report model observations. */
import { open, previewFixture, unzipSync, zipSync, strFromU8, strToU8, pixelDifference } from './runtime.mjs';
const [kind = 'shape', action = 'move'] = process.argv.slice(2);
const files = unzipSync(previewFixture('pptx'));
const shape = (id, x, y, text = '') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Audit shape ${id}"/><p:cNvSpPr${kind === 'textbox' ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="1905000" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="3355CC"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="2000"><a:latin typeface="Arial"/></a:rPr><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;
let object = shape(2, 952500, 952500, kind === 'textbox' ? 'Alpha Beta Gamma' : '');
if (kind === 'connector') object = '<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="2" name="Audit connector"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1143000"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="38100"><a:solidFill><a:srgbClr val="3355CC"/></a:solidFill></a:ln></p:spPr></p:cxnSp>';
if (kind === 'roundrect') object = object.replace('prst="rect"><a:avLst/>', 'prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"/></a:avLst>');
if (kind === 'group') object = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="9" name="Audit group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="3810000" cy="1143000"/><a:chOff x="0" y="0"/><a:chExt cx="3810000" cy="1143000"/></a:xfrm></p:grpSpPr>${shape(2, 0, 0)}${shape(3, 1905000, 0)}</p:grpSp>`;
if (kind === 'picture') {
  // A fixed opaque 8x8 PNG; geometry is independently observed in the saved XML.
  files['ppt/media/image1.png'] = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMQsbmDFTEMLQkAHHtLAaY+JhQAAAAASUVORK5CYII=', 'base64');
  files['[Content_Types].xml'] = strToU8(strFromU8(files['[Content_Types].xml']).replace('</Types>', '<Default Extension="png" ContentType="image/png"/></Types>'));
  files['ppt/slides/_rels/slide1.xml.rels'] = strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>');
  object = '<p:pic><p:nvPicPr><p:cNvPr id="2" name="Audit image"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}
files['ppt/slides/slide1.xml'] = strToU8(strFromU8(files['ppt/slides/slide1.xml']).replace(/<p:sp>[\s\S]*?<\/p:sp>/, object));
const r = await open(zipSync(files), 'pptx');
try {
  await r.operation({ type: 'viewport', rectangle: { x: 0, y: 0, width: 960, height: 720 }, scale: 1 });
  const before = await r.paint();
  await r.click(kind === 'connector' ? 200 : 250, kind === 'connector' ? 160 : 190);
  const selectedBefore = r.reader.state.graphicSelection;
  if (action === 'move') await r.drag(250, 190, 80, 60);
  else if (action === 'resize') await r.drag(kind === 'group' ? 500 : 300, 220, 80, 60);
  else if (action === 'ctrl-drag') await r.drag(250, 190, 80, 60, 0x2000);
  else if (action === 'ctrl-resize') await r.drag(300, 220, 80, 60, 0x2000);
  else if (action === 'shift-resize') await r.drag(300, 220, 80, 60, 0x1000);
  else if (action === 'shift-drag') await r.drag(250, 190, 80, 60, 0x1000);
  else if (action === 'adjust') await r.drag(120, 100, 50, 0);
  else if (action === 'group-deep-resize') { await r.click(250, 190, 0, 2); await r.click(250, 190); await r.drag(300, 220, 80, 60); }
  else if (action === 'selectall-arrow') { await r.operation({ type: 'select-all' }); await r.operation({ type: 'navigate', event: { key: 'right' } }); }
  else if (action === 'double-arrow') { await r.click(150, 120, 0, 2); await r.operation({ type: 'navigate', event: { key: 'right' } }); }
  else if (action === 'arrow' || action === 'ctrl-arrow' || action === 'shift-arrow') await r.operation({ type: 'navigate', event: { key: 'right', word: action === 'ctrl-arrow', extend: action === 'shift-arrow' } });
  else if (action !== 'click') throw new Error('Unknown probe');
  const selectedAfter = r.reader.state.graphicSelection, undo = JSON.parse(r.query('.uno:Undo'));
  const copied = await r.copy();
  await r.click(850, 650);
  const after = await r.paint();
  const result = r.exportFiles();
  const xml = strFromU8(result['ppt/slides/slide1.xml']);
  console.log(JSON.stringify({ kind, action, selectedBefore, selectedAfter, changedPixels: pixelDifference(before, after), undo,
    copied, xfrm: [...xml.matchAll(/<a:xfrm[\s\S]*?<\/a:xfrm>/g)].map(m => m[0]),
    adjustments: [...xml.matchAll(/<a:gd[^>]+/g)].map(m => m[0]), names: [...xml.matchAll(/<p:cNvPr[^>]*name="([^"]*)"/g)].map(m => m[1]), failures: r.failures }));
} finally { await r.close(); }
