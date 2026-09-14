/** Reproducible public build identity; private paths remain only in the build tree. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const buildVendor = 'DeepSeek';
const compilerFlagKeys = ['CFLAGS', 'CXXFLAGS', 'OBJCFLAGS', 'OBJCXXFLAGS', 'ENVCFLAGS', 'ENVCFLAGSCXX'];

/** Map the most specific paths first, including external build directories. */
export function buildPathMap(paths) {
  return Object.entries(paths).filter(([, value]) => value).map(([name, value]) => {
    if (!/^[A-Za-z0-9_./:\\-]+$/.test(value)) throw new Error('Build paths must not contain whitespace or shell metacharacters');
    return [value.replaceAll('\\', '/').replace(/\/$/, ''), `/build/libreoffice-kit/${name}`];
  }).sort((a, b) => b[0].length - a[0].length);
}

export function publicBuildValue(value, paths) {
  const mappings = buildPathMap(paths);
  const replace = text => {
    for (const [from, to] of mappings) text = text.replaceAll(from, to).replaceAll(from.replaceAll('/', '\\'), to);
    return text;
  };
  const visit = item => typeof item === 'string' ? replace(item) : Array.isArray(item) ? item.map(visit)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)])) : item;
  return visit(value);
}

export function buildPathFlags(platform, paths) {
  return buildPathMap(paths).reverse().flatMap(([from, to]) => platform.startsWith('win32-')
    ? [`/pathmap:${from}=${to}`]
    : [`-ffile-prefix-map=${from}=${to}`, `-fdebug-prefix-map=${from}=${to}`]);
}

/** Both gbuild and external configure projects receive the prefix mappings. */
export function buildEnvironment(environment, platform, paths) {
  const result = Object.fromEntries(Object.entries(environment).filter(([key]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(key)));
  const flags = buildPathFlags(platform, paths).join(' ');
  for (const key of compilerFlagKeys) result[key] = `${result[key] ?? ''} ${flags}`.trim();
  return result;
}

/** Hashed private receipt prevents resuming a tree configured without these flags. */
export function buildIdentity(platform, paths, environment) {
  const flags = Object.fromEntries(compilerFlagKeys.map(key => [key, environment[key] ?? '']));
  return { schemaVersion: 1, vendor: buildVendor,
    recipe: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    configuration: createHash('sha256').update(JSON.stringify({ platform, paths, flags })).digest('hex'),
    compilerFlags: publicBuildValue(flags, paths) };
}
