/** Synthetic pixel statistics for publication metadata tests. */
export function renderingEvidenceFixture(backend) {
  return Object.fromEntries(['docx', 'xlsx', 'pptx'].map(format => [format, {
    backend, rasterEngine: 'libreoffice', width: 200, height: 100,
    visiblePixels: 2200, redPixels: 1000, bluePixels: 1000, darkPixels: 200,
    redCenterX: 50, blueCenterX: 150,
  }]));
}
