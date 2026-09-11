/** Pinned LibreOffice Core build inputs for the private conversion worker. */
export const source = Object.freeze({
  repository: 'https://github.com/LibreOffice/core.git',
  revision: 'bce0998afefdbc355585ca324285661a2170ba77',
});

export function configureFlags(platform, tarballs, parallelism) {
  const flags = [
    '--disable-debug', '--disable-dbgutil', '--disable-symbols', '--disable-werror',
    '--disable-pch', '--without-java', '--enable-python=no', '--without-doxygen',
    '--without-help', '--without-myspell-dicts', '--without-fonts',
    '--disable-opencl', '--disable-opengl', '--disable-odk', '--disable-online-update',
    '--disable-extension-integration', '--disable-dbus', '--disable-cups',
    '--disable-gstreamer-1-0', '--disable-firebird-sdbc', '--disable-postgresql-sdbc',
    '--disable-mariadb-sdbc', '--disable-report-builder', '--disable-ext-nlpsolver',
    '--disable-coinmp', '--disable-ccache', '--with-lang=en-US',
    `--with-external-tar=${tarballs}`, `--with-parallelism=${parallelism}`,
  ];
  if (!platform.startsWith('darwin-')) flags.push('--disable-skia');
  if (platform.startsWith('linux-')) flags.push('--disable-gui', '--disable-gtk3', '--disable-qt5', '--disable-qt6', '--disable-gen', '--without-x',
    '--without-system-cairo', '--without-system-fontconfig', '--without-system-freetype', '--without-system-harfbuzz', '--without-system-graphite');
  // Core's configure rejects --disable-gui on macOS and Windows; LOK initializes headless itself.
  if (platform.startsWith('darwin-')) flags.push('--enable-bogus-pkg-config');
  if (platform.startsWith('win32-')) flags.push(`--host=${platform.endsWith('arm64') ? 'aarch64' : 'x86_64'}-pc-cygwin`);
  return flags;
}
