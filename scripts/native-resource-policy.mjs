/** Reviewed resource exclusions for the native conversion recipe. UI paths are relative to soffice.cfg. */
export const nativeUiResources = [
  // DBCONNECTIVITY: sw/Library_swui.mk excludes the mail-merge dialog objects.
  'modules/swriter/ui/addressblockdialog.ui',
  'modules/swriter/ui/addressfragment.ui',
  'modules/swriter/ui/alreadyexistsdialog.ui',
  'modules/swriter/ui/assignfieldsdialog.ui',
  'modules/swriter/ui/assignfragment.ui',
  'modules/swriter/ui/attachnamedialog.ui',
  'modules/swriter/ui/ccdialog.ui',
  'modules/swriter/ui/createaddresslist.ui',
  'modules/swriter/ui/customizeaddrlistdialog.ui',
  'modules/swriter/ui/findentrydialog.ui',
  'modules/swriter/ui/insertdbcolumnsdialog.ui',
  'modules/swriter/ui/mmaddressblockpage.ui',
  'modules/swriter/ui/mmlayoutpage.ui',
  'modules/swriter/ui/mmmailbody.ui',
  'modules/swriter/ui/mmoutputtypepage.ui',
  'modules/swriter/ui/mmresultemaildialog.ui',
  'modules/swriter/ui/mmresultprintdialog.ui',
  'modules/swriter/ui/mmresultsavedialog.ui',
  'modules/swriter/ui/mmsalutationpage.ui',
  'modules/swriter/ui/mmselectpage.ui',
  'modules/swriter/ui/mmsendmails.ui',
  'modules/swriter/ui/selectaddressdialog.ui',
  'modules/swriter/ui/selectblockdialog.ui',
  'modules/swriter/ui/selecttabledialog.ui',
  'modules/swriter/ui/subjectdialog.ui',
  'modules/swriter/ui/tablepreviewdialog.ui',
  'modules/swriter/ui/warnemaildialog.ui',
  // The same excluded objects use these paths from customizeaddresslistdialog.hxx.
  'modules/swriter/ui/addentrydialog.ui',
  'modules/swriter/ui/renameentrydialog.ui',
  // DBCONNECTIVITY: sw/Library_sw.mk excludes mailmergetoolbarcontrols.
  'modules/swriter/ui/checkbox.ui',
  'modules/swriter/ui/editbox.ui',
  // DBCONNECTIVITY guards all creation sites in view2.cxx, swdlgfact.cxx, fldtdlg.cxx and fldedt.cxx.
  'modules/swriter/ui/datasourcesunavailabledialog.ui',
  'modules/swriter/ui/warndatasourcedialog.ui',
  'modules/swriter/ui/exchangedatabases.ui',
  'modules/swriter/ui/flddbpage.ui',
  // DBG_UTIL: sw/source/ui/config/optpage.cxx excludes the entire test page.
  'modules/swriter/ui/opttestpage.ui',
  // DBCONNECTIVITY: extensions/Module_extensions.mk excludes Library_dbp, but retains Library_abp.
  'modules/sabpilot/ui/contentfieldpage.ui',
  'modules/sabpilot/ui/contenttablepage.ui',
  'modules/sabpilot/ui/defaultfieldselectionpage.ui',
  'modules/sabpilot/ui/fieldlinkpage.ui',
  'modules/sabpilot/ui/gridfieldsselectionpage.ui',
  'modules/sabpilot/ui/groupradioselectionpage.ui',
  'modules/sabpilot/ui/optiondbfieldpage.ui',
  'modules/sabpilot/ui/optionsfinalpage.ui',
  'modules/sabpilot/ui/optionvaluespage.ui',
  'modules/sabpilot/ui/tableselectionpage.ui',
  // DBCONNECTIVITY and BREAKPAD: svx/Library_svx.mk excludes filtnav and crashreportdlg.
  'svx/ui/filtermenu.ui',
  'svx/ui/filternavigator.ui',
  'svx/ui/crashreportdlg.ui',
  // SCRIPTING: cui/Library_cui.mk excludes MacroManagerDialog and optbasic.
  'cui/ui/macromanagerdialog.ui',
  'cui/ui/optbasicidepage.ui',
  // SCRIPTING: basic/Library_sb.mk excludes both inputbox and iosys objects.
  'svt/ui/inputbox.ui',
  // EXTENSIONS: cui/Library_cui.mk excludes AdditionsDialog.
  'cui/ui/additionsdialog.ui',
  'cui/ui/additionsfragment.ui',
  // JAVA: svtools/Library_svt.mk excludes javainteractionhandler; optjava.cxx guards both creation sites.
  'svt/ui/javadisableddialog.ui',
  'cui/ui/javaclasspathdialog.ui',
  'cui/ui/javastartparametersdialog.ui',
  // CUPS: vcl/Library_vcl.mk excludes cupsmgr.
  'vcl/ui/cupspassworddialog.ui',
  // Only test/source/screenshot_test.cxx loads this test-harness container.
  'vcl/ui/screenshotparent.ui',
];

export const darwinUiResources = [
  // configure.ac disables FreeType/fontconfig on macOS; vcl/Library_vcl.mk omits Unix printer UI.
  'vcl/ui/printerdevicepage.ui',
  'vcl/ui/printerpaperpage.ui',
  'vcl/ui/printerpropertiesdialog.ui',
  'vcl/ui/querydialog.ui',
  // Only the GTK3 backend (vcl/unx/gtk3/gtkinst.cxx) loads this resource.
  'vcl/ui/combobox.ui',
];

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
