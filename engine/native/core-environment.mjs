/** Preserve MSVC discovery inputs while isolating Core's Cygwin/Make environment. */
export function windowsCoreEnvironment(environment, coreExportsSource) {
  const result = { ...environment };
  const coreExports = new Set([...coreExportsSource.matchAll(/\bexport[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/g)].map(match => match[1]));
  const conflicts = [];
  for (const key of Object.keys(environment)) {
    const canonical = key.toUpperCase();
    // Core rebuilds UCRTVERSION in find_ucrt and uses INCLUDE for -I flags, not MSVC's path list.
    if (canonical === 'INCLUDE' || canonical === 'UCRTVERSION') delete result[key];
    else if (canonical === 'PATH') {
      delete result[key];
      result.PATH = environment[key];
    } else if (key !== canonical && coreExports.has(canonical)) conflicts.push(`${key}/${canonical}`);
  }
  if (conflicts.length) throw new Error(`MSVC environment aliases conflict with Core exports: ${conflicts.sort().join(', ')}`);
  return result;
}
