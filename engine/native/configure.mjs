/** Pinned LibreOffice Core build inputs for the private conversion worker. */
import { readCoreSource } from '../core-source.mjs';
import { buildVendor } from '../build-identity.mjs';
export const source = readCoreSource();

export function configureFlags(platform, tarballs, parallelism, visualStudio = '2022') {
  const flags = [
    `--with-vendor=${buildVendor}`,
    '--disable-debug', '--disable-dbgutil', '--disable-symbols', '--disable-werror',
    '--disable-pch', '--without-java', '--enable-python=no', '--without-doxygen',
    '--without-help', '--without-myspell-dicts', '--without-fonts',
    '--disable-pdfimport', '--disable-xmlhelp', '--disable-curl', '--without-webdav',
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
  if (platform.startsWith('win32-')) {
    if (!['2022', '2026'].includes(visualStudio)) throw new Error('LIBREOFFICE_KIT_VISUAL_STUDIO must be 2022 or 2026');
    flags.push(`--host=${platform.endsWith('arm64') ? 'aarch64' : 'x86_64'}-pc-cygwin`,
      `--with-visual-studio=${visualStudio}`, '--without-lxml', '--enable-skia');
    if (platform === 'win32-arm64') flags.push(`--with-build-platform-configure-options=--with-visual-studio=${visualStudio}`);
  }
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
  const expected = configureFlags(platform, '', '', visualStudio);
  const components = values => values.filter(flag => !/^--with-(external-tar|parallelism)=/.test(flag));
  if (JSON.stringify(components(flags)) !== JSON.stringify(components(expected)))
    throw new Error('Core configure input differs from the current recipe; rebuild Core without --resume');
}
