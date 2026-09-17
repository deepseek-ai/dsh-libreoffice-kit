/** Desktop resource paths are relative to the platform's Resources/share directory. */
export const nativeDesktopResources = [
  // Disabled Java/database form wizard; extras/Package_cfgsrvnolang.mk installs its CSS independently.
  'config/wizard/form/styles',
  // LDAP is disabled; officecfg/Package_misc.mk installs these example configurations.
  'registry/oo-ad-ldap.xcd.sample',
  'registry/oo-ldap.xcd.sample',
  // iOS-only widget theme; vcl's native conversion backends do not select it.
  'theme_definitions/ios',
  // Glade editor metadata, installed by extras/Package_glade.mk.
  'glade/libreoffice-catalog.xml',
];

export const darwinDesktopResources = [
  // macOS Skia uses Metal; vcl/skia/SkiaHelper.cxx only reads this denylist for Vulkan.
  'skia/skia_denylist_vulkan.xml',
  // macOS desktop launcher scripts live in Resources, outside the worker's entry point.
  'senddoc',
  'unoinfo',
];
