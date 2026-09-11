param([Parameter(Mandatory = $true)][string]$CygwinDirectory)

$ErrorActionPreference = 'Stop'
$toolsDirectory = Join-Path (Get-Location) '.build/windows-tools'
New-Item -ItemType Directory -Force -Path $toolsDirectory | Out-Null

# URLs and hashes are pinned by Core's .config/admin_java_and_deps.winget.
$downloads = @(
    @{ Name = 'make.exe'; Uri = 'https://dev-www.libreoffice.org/bin/cygwin/make-4.2.1-msvc.exe'; Sha256 = '146d6f2b0ea57647b11b506a95048a7be73232e1feeeccbc1013651f992423d8' },
    @{ Name = 'pkgconf.exe'; Uri = 'https://dev-www.libreoffice.org/extern/pkgconf-2.4.3.exe'; Sha256 = '791cd6dbc56f7268fbf9c4652d6634b0f5c59687ab4e504565e58245952edd41' }
)
foreach ($download in $downloads) {
    $destination = Join-Path $toolsDirectory $download.Name
    Invoke-WebRequest -Uri $download.Uri -OutFile $destination
    if ((Get-FileHash -Path $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $download.Sha256) {
        throw "Downloaded $($download.Name) does not match the pinned Core tool hash."
    }
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$year = [string](& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property catalog_productLineVersion)
$year = $year.Trim()
if ($LASTEXITCODE -ne 0 -or $year -notin @('2022', '2026')) { throw 'Core requires Visual Studio 2022 or 2026 with C++ desktop tools.' }
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) { throw 'The MSVC developer command environment has not been initialized.' }
foreach ($tool in @('bash.exe', 'cygpath.exe')) {
    if (-not (Test-Path (Join-Path $CygwinDirectory "bin/$tool"))) { throw "The Cygwin build tool is missing: $tool" }
}
& (Join-Path $CygwinDirectory 'bin/bash.exe') -c 'PATH=/usr/bin:/bin; for tool in autoconf perl python3 nasm; do command -v "$tool" || exit 1; done'
if ($LASTEXITCODE -ne 0) { throw 'Cygwin is missing a required configure tool.' }
$python = (Get-Command python.exe -ErrorAction Stop).Source
& $python -c 'import sys; assert sys.platform == "win32" and sys.version_info >= (3, 7)'
if ($LASTEXITCODE -ne 0) { throw 'Core requires a native Windows Python interpreter for build tools.' }
$pythonForBuild = & (Join-Path $CygwinDirectory 'bin/cygpath.exe') -m -s $python
if ($LASTEXITCODE -ne 0 -or -not $pythonForBuild) { throw 'Cannot resolve the native Windows Python path.' }

"LIBREOFFICE_KIT_CYGWIN=$CygwinDirectory" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"LIBREOFFICE_KIT_MAKE=$(Join-Path $toolsDirectory 'make.exe')" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"LIBREOFFICE_KIT_VISUAL_STUDIO=$year" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"PKG_CONFIG=$(Join-Path $toolsDirectory 'pkgconf.exe')" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
"PYTHON_FOR_BUILD=$pythonForBuild" | Out-File -Append -Encoding utf8 $env:GITHUB_ENV
Write-Output "Windows Core tools ready: Visual Studio $year; Cygwin $CygwinDirectory; pinned native GNU Make and pkgconf."
