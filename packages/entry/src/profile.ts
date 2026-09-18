/** Private headless profile used by both native and WASM conversions. */

/**
 * CSV selection is checked by the engine wrapper before saving; suppress the interactive warning.
 * @param fontNodes - Escaped VCL font-substitution nodes, or an empty string for WASM.
 * @returns The per-operation registry XML; macro execution is independently disabled at load.
 */
export function profileXml(fontNodes = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Calc/Input"><prop oor:name="WarnActiveSheet" oor:op="fuse"><value>false</value></prop></item><item oor:path="/org.openoffice.VCL/FontSubstitutions/en">${fontNodes}</item></oor:items>\n`
}
