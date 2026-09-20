/** Run one isolated native readonly gesture and report model observations. */
import { open, previewFixture, zipSync, unzipSync, strToU8, strFromU8, pixelDifference } from './runtime.mjs';
const kind = process.argv[2] ?? 'shape', action = process.argv[3] ?? 'resize';
const files=unzipSync(previewFixture('xlsx'));
files['[Content_Types].xml']=strToU8(strFromU8(files['[Content_Types].xml']).replace('</Types>','<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>'));
files['xl/worksheets/sheet1.xml']=strToU8(strFromU8(files['xl/worksheets/sheet1.xml']).replace('<worksheet ','<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ').replace('</worksheet>','<drawing r:id="rIdDrawing"/></worksheet>'));
files['xl/worksheets/_rels/sheet1.xml.rels']=strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDrawing" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>');
let object='<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="Calc audit shape"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="3355CC"/></a:solidFill></xdr:spPr><xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Audit</a:t></a:r></a:p></xdr:txBody></xdr:sp>';
if(kind==='roundrect')object=object.replace('prst="rect"><a:avLst/>','prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 16667"/></a:avLst>');
if(kind==='textbox')object=object.replace('<xdr:cNvSpPr/>','<xdr:cNvSpPr txBox="1"/>');
if(kind==='connector')object='<xdr:cxnSp><xdr:nvCxnSpPr><xdr:cNvPr id="2" name="Calc audit connector"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr><a:xfrm><a:off x="952500" y="952500"/><a:ext cx="1905000" cy="1143000"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="38100"><a:solidFill><a:srgbClr val="3355CC"/></a:solidFill></a:ln></xdr:spPr></xdr:cxnSp>';
files['xl/drawings/drawing1.xml']=strToU8(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:absoluteAnchor><xdr:pos x="952500" y="952500"/><xdr:ext cx="1905000" cy="1143000"/>${object}<xdr:clientData/></xdr:absoluteAnchor></xdr:wsDr>`);
const r = await open(zipSync(files), 'xlsx');
try {
  await r.operation({ type: 'viewport', rectangle: { x: 0, y: 0, width: 960, height: 720 }, scale: 1 });
  const before = await r.paint();
  await r.click(kind === 'connector' ? 200 : 250, kind === 'connector' ? 160 : 190);
  const beforeSelection = r.reader.state.graphicSelection;
  if (action === 'resize') await r.drag(300, 220, 80, 60);
  else if (action === 'move') await r.drag(250, 190, 80, 60);
  else if (action === 'adjust') await r.drag(120, 100, 50, 0);
  else if (action !== 'click') throw Error('Unknown action');
  const afterSelection = r.reader.state.graphicSelection, undo = r.query('.uno:Undo');
  await r.click(800, 650);
  const after = await r.paint();
  await r.operation({ type: 'cell', address: 'A1:B1' });
  const copied = await r.copy();
  const xml = strFromU8(r.exportFiles()['xl/drawings/drawing1.xml']);
  console.log(JSON.stringify({ kind, action, beforeSelection, afterSelection, undo,
    changedPixels: pixelDifference(before, after), copied,
    anchors: [...xml.matchAll(/<xdr:(?:from|to)>[\s\S]*?<\/xdr:(?:from|to)>|<xdr:(?:pos|ext) [^>]*\/>/g)].map(match => match[0]),
    xfrm: [...xml.matchAll(/<a:xfrm[\s\S]*?<\/a:xfrm>/g)].map(match => match[0]),
    adjustments: [...xml.matchAll(/<a:gd[^>]+/g)].map(match => match[0]), failures: r.failures }));
} finally { await r.close(); }
