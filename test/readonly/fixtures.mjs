/** Synthetic OOXML fixtures with known object geometry for read-only gesture probes. */
import { createRequire } from 'node:module'

const { zipSync, strToU8 } = createRequire(new URL('../../packages/entry/package.json', import.meta.url))('fflate')

const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships'
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function packageFiles(types, files, main) {
  files['_rels/.rels'] = `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="${main}"/></Relationships>`
  files['[Content_Types].xml'] = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `${Object.entries(types).map(([part, type]) => `<Override PartName="/${part}" ContentType="${type}"/>`).join('')}</Types>`
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])))
}

const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

function txBody(text, size = 1800) {
  return `<a:p><a:r><a:rPr lang="en-US" sz="${size}"><a:latin typeface="Liberation Sans"/></a:rPr><a:t>${text}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>`
}

function cell(text, size = 1800) {
  return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>${txBody(text, size)}</a:txBody><a:tcPr/></a:tc>`
}

/** One 960×720 slide with a 2×3 table at (96, 192), sized 768×192 CSS pixels. */
function pptxTable() {
  const types = {
    'ppt/presentation.xml': 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    'ppt/slides/slide1.xml': 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  }
  const files = {}
  files['ppt/presentation.xml'] = `<p:presentation xmlns:p="${P}" xmlns:r="${office}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`
  files['ppt/_rels/presentation.xml.rels'] = `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${office}/slide" Target="slides/slide1.xml"/></Relationships>`
  const columns = [2438400, 2438400, 2438400].map(width => `<a:gridCol w="${width}"/>`).join('')
  const row = texts => `<a:tr h="914400">${texts.map(text => cell(text)).join('')}</a:tr>`
  files['ppt/slides/slide1.xml'] = `<p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree>`
    + `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
    + `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`
    + `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="2" name="Data table"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>`
    + `<p:xfrm><a:off x="914400" y="1828800"/><a:ext cx="7315200" cy="1828800"/></p:xfrm>`
    + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>`
    + `<a:tblPr firstRow="0" bandRow="0"/><a:tblGrid>${columns}</a:tblGrid>`
    + row(['Header A', 'Header B', 'Header C']) + row(['Body A', 'Body B', 'Body C'])
    + `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Box"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="914400" y="4572000"/><a:ext cx="2743200" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>`
    + `<a:solidFill><a:srgbClr val="FFCC00"/></a:solidFill></p:spPr>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/>${txBody('Box object')}</p:txBody></p:sp>`
    + `<p:sp><p:nvSpPr><p:cNvPr id="4" name="Text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="4572000" y="4572000"/><a:ext cx="3657600" cy="1371600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr/><a:lstStyle/>${txBody('Editable text object')}</p:txBody></p:sp>`
    + `</p:spTree></p:cSld></p:sld>`
  return packageFiles(types, files, 'ppt/presentation.xml')
}

export function fixtureBytes(name) {
  if (name !== 'pptx-table') throw new Error('Unknown readonly table fixture');
  return pptxTable();
}
