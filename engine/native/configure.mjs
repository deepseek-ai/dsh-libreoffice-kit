/** Pinned LibreOffice Core build inputs for the private conversion worker. */
import { readCoreSource } from '../core-source.mjs';
import { buildVendor } from '../build-identity.mjs';
export const source = readCoreSource();

export function nativeBuildOptions(platform, { optimization = platform === 'darwin-arm64' ? 'Oz' : 'default', lto = platform === 'darwin-arm64', clangCl = false } = {}) {
  if (clangCl && platform !== 'win32-x64') throw new Error('--clang-cl is experimental and requires win32-x64');
  if (!['default', 'O2', 'Os', 'Oz'].includes(optimization)) throw new Error('--optimization must be default, O2, Os, or Oz');
  if ((lto || optimization !== 'default') && platform !== 'darwin-arm64' && !clangCl)
    throw new Error('Optimization overrides are qualified only for darwin-arm64; Windows experiments require --clang-cl');
  // clang-cl needs forwarded options; make the O2 control explicit so prefix maps never suppress optimization.
  return { optimization: clangCl && optimization === 'default' ? 'O2' : optimization, lto };
}

export function configureFlags(platform, tarballs, parallelism, visualStudio = '2022', crossCompile = false, { lto = nativeBuildOptions(platform).lto } = {}) {
  if (lto && !['darwin-arm64', 'win32-x64'].includes(platform)) throw new Error('LTO is qualified only for darwin-arm64 or experimental win32-x64');
  const flags = [
    `--with-vendor=${buildVendor}`,
    '--disable-debug', '--disable-dbgutil', '--disable-symbols', '--disable-werror',
    '--disable-pch', '--without-java', '--enable-python=no', '--without-doxygen',
    '--without-help', '--without-myspell-dicts', '--without-fonts',
    '--disable-pdfimport', '--enable-pdfium', '--disable-xmlhelp', '--disable-curl', '--without-webdav',
    '--disable-libcmis', '--disable-breakpad', '--disable-ldap',
    '--disable-opencl', '--disable-opengl', '--disable-odk', '--disable-online-update',
    '--disable-extension-integration', '--disable-dbus', '--disable-cups',
    '--disable-extensions', '--disable-database-connectivity', '--disable-scripting',
    '--disable-sdremote', '--disable-sdremote-bluetooth',
    '--with-galleries=no', '--with-templates=no', '--with-theme=no',
    '--disable-gstreamer-1-0', '--disable-firebird-sdbc', '--disable-postgresql-sdbc',
    '--disable-mariadb-sdbc', '--disable-report-builder', '--disable-ext-nlpsolver',
    '--disable-coinmp', '--disable-ccache', '--with-lang=en-US',
    `--with-external-tar=${tarballs}`, `--with-parallelism=${parallelism}`,
  ];
  if (platform.startsWith('linux-')) flags.push('--disable-skia');
  if (platform.startsWith('linux-')) flags.push('--disable-gui', '--disable-gtk3', '--disable-qt5', '--disable-qt6', '--disable-gen', '--without-x',
    '--without-gssapi', '--without-system-cairo', '--without-system-fontconfig', '--without-system-freetype', '--without-system-harfbuzz', '--without-system-graphite');
  // Core's configure rejects --disable-gui on macOS and Windows; LOK initializes headless itself.
  if (platform.startsWith('darwin-')) flags.push('--enable-bogus-pkg-config');
  // Core archive linkage, retaining Skia and using OpenSSL for crypto.
  flags.push('--disable-dynamic-loading', '--enable-customtarget-components',
    '--disable-nss', '--disable-gpgmepp', '--with-tls=openssl');
  const buildPlatform = ['--enable-python=no', '--without-lxml', '--without-doxygen',
    '--disable-odk', '--disable-werror', '--disable-debug', '--disable-symbols'];
  if (platform.startsWith('darwin-')) buildPlatform.push('--enable-bogus-pkg-config', '--enable-skia');
  if (platform.startsWith('linux-')) buildPlatform.push('--disable-gui', '--disable-gtk3', '--disable-qt5',
    '--disable-qt6', '--disable-gen', '--without-x', '--disable-skia');
  if (crossCompile && platform.startsWith('darwin-')) {
    if (platform !== 'darwin-x64') throw new Error('macOS cross-compilation supports only ARM64 to x64');
    flags.push('--build=aarch64-apple-darwin', '--host=x86_64-apple-darwin');
  }
  if (platform.startsWith('win32-')) {
    if (!['2022', '2026'].includes(visualStudio)) throw new Error('LIBREOFFICE_KIT_VISUAL_STUDIO must be 2022 or 2026');
    flags.push(`--host=${platform.endsWith('arm64') ? 'aarch64' : 'x86_64'}-pc-cygwin`,
      `--with-visual-studio=${visualStudio}`, '--without-lxml', '--enable-skia', '--disable-cli');
    buildPlatform.push(`--with-visual-studio=${visualStudio}`, '--enable-skia');
  }
  flags.push(`--with-build-platform-configure-options=${buildPlatform.join(' ')}`);
  if (lto) flags.push('--enable-lto');
  return flags;
}

/**
 * Reject configured or cached Core trees with a different component selection.
 * Download-cache paths and build parallelism do not affect selected components.
 * @param platform - Native engine target.
 * @param flags - Recorded autogen.input arguments, one entry per line.
 */
export function verifyConfigureInput(platform, flags) {
  if (!Array.isArray(flags) || !flags.every(flag => typeof flag === 'string')) throw new Error('Core configure receipt must contain argument strings');
  const visualStudio = flags.find(flag => flag.startsWith('--with-visual-studio='))?.split('=')[1];
  const crossCompile = platform === 'darwin-x64' && flags.includes('--build=aarch64-apple-darwin');
  const expected = configureFlags(platform, '', '', visualStudio, crossCompile, { lto: flags.includes('--enable-lto') });
  const components = values => values.filter(flag => !/^--with-(external-tar|parallelism)=/.test(flag));
  if (JSON.stringify(components(flags)) !== JSON.stringify(components(expected)))
    throw new Error('Core configure input differs from the current recipe; rebuild Core without --resume');
}
