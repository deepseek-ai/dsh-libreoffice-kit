# Run in the matching MSVC developer shell after building the static engine.
param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$Build,
    [string]$Compiler = 'clang-cl.exe'
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$target = if ($env:VSCMD_ARG_TGT_ARCH -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { 'x86_64-pc-windows-msvc' }
& $Compiler --target=$target /nologo /std:c++20 /EHsc /MD /DDISABLE_DYNLOADING /I"$Source/include" /I"$Build/config_host" /I"$Build" "$repo/test/windows-path-probe.cxx" /Fe"$Build/windows-path-probe.exe" /Fo"$Build/windows-path-probe.obj" -fuse-ld=lld /link "$Build/instdir/program/isal.lib" "$Build/workdir/LinkTarget/StaticLibrary/zlib.lib" advapi32.lib comdlg32.lib dbghelp.lib mpr.lib ole32.lib shell32.lib user32.lib userenv.lib wer.lib ws2_32.lib
exit $LASTEXITCODE
