param([string]$OutputDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue) -or $env:VSCMD_ARG_TGT_ARCH -ne 'x64') {
  $VsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
  if (-not (Test-Path $VsWhere)) { throw 'Visual Studio C++ build tools are required.' }
  $VisualStudio = & $VsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if (-not $VisualStudio) { throw 'Visual Studio x64 C++ build tools were not found.' }
  & (Join-Path $VisualStudio 'Common7/Tools/Launch-VsDevShell.ps1') -Arch amd64 -HostArch amd64 -SkipAutomaticLocation
}
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path $OutputDirectory).Path
$Source = Join-Path $PSScriptRoot 'rooms-windows-capture.cpp'
$Executable = Join-Path $OutputDirectory 'rooms-windows-capture.exe'
$Object = Join-Path $OutputDirectory 'rooms-windows-capture.obj'
$CompilerArguments = @(
  '/nologo', '/std:c++17', '/O2', '/EHsc', '/MT', '/W4', '/utf-8',
  '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00', "/Fo$Object", "/Fe$Executable", $Source,
  '/link', '/MACHINE:X64', '/DYNAMICBASE', '/NXCOMPAT', '/HIGHENTROPYVA',
  'd3d11.lib', 'dxgi.lib', 'runtimeobject.lib', 'user32.lib'
)
& cl.exe @CompilerArguments
if ($LASTEXITCODE -ne 0) { throw 'Windows video helper compilation failed.' }
