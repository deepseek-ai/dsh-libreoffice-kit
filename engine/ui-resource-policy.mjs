/** Headless InterimItemWindow layouts, relative to share/config/soffice.cfg. */
export const requiredUiResources = Object.freeze([
  'modules/scalc/ui/inputbar.ui',
  'modules/scalc/ui/posbox.ui',
  'modules/simpress/ui/tabviewbar.ui',
  'svt/ui/scrollbars.ui',
  'svt/ui/tabbuttons.ui',
]);

// Evidence scope, not a source pin: engine/core remains the only source pin.
// Rerun scripts/minimize-ui-resources.py on a complete installation when Core changes.
export const reviewedUiCoreRevision = 'bce0998afefdbc355585ca324285661a2170ba77';

export function assertUiCoreRevision(revision) {
  if (revision !== reviewedUiCoreRevision)
    throw new Error('Core changed: rerun scripts/minimize-ui-resources.py and review the UI allowlist before packaging');
}

export function assertRequiredUiResources(paths) {
  const present = new Set(paths);
  for (const file of requiredUiResources)
    if (!present.has(file)) throw new Error(`Missing required headless UI resource: ${file}`);
}

/** Remove only .ui layouts; adjacent configuration and other resources keep their own policies. */
export function unusedUiResource(path) {
  return path.endsWith('.ui') && !requiredUiResources.includes(path);
}
