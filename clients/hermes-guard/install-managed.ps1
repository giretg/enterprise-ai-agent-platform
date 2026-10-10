<#
Excellence gép-padló telepítő natív Windowsra (#755). Rendszergazdai PowerShellből, idempotensen.

  .\install-managed.ps1 floor.json
  .\install-managed.ps1 floor.json -User CEG\kovacs.anna -Python "C:\Program Files\Python312\python.exe"
  pwsh ./install-managed.ps1 floor.json -Prefix /tmp/stage     # teszthez, admin nélkül

A floor.json a GET /api/client-policy/machine-floor?userId=...&platform=windows válasza.
WSL-ben futó Hermeshez a disztribúción belül az install-managed.sh kell, nem ez.

Felteszi (C:\ProgramData\Excellence, csak SYSTEM és Administrators írhatja):
  hermes\{config.yaml,.env,excellence-install-id}   a letöltött padló
  bin\exc-token(.cmd), bin\exc-guard(.cmd)          token-segéd és shell-hook tartalék
  hermes-plugins\excellence-guard                   a Guard plugin
és gépszintű HERMES_MANAGED_DIR-t állít, mert a Hermes Windowson nem keres natív managed helyet.
#>
param(
  [Parameter(Mandatory = $true, Position = 0)][string]$Package,
  [string]$Python = '',
  [string]$User = '',
  [string]$Prefix = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

function Fail([string]$message) {
  [Console]::Error.WriteLine($message)
  exit 1
}

$Testing = $Prefix -ne ''
if ($Testing) {
  $Root = Join-Path $Prefix 'ProgramData/Excellence'
} else {
  $Root = 'C:\ProgramData\Excellence'
  $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'A telepítő rendszergazdaként fut: nyiss egy "Futtatás rendszergazdaként" PowerShellt.'
  }
}
$Managed = Join-Path $Root 'hermes'
$Bin = Join-Path $Root 'bin'
$PluginRoot = Join-Path $Root 'hermes-plugins'
$Names = 'config.yaml', '.env', 'excellence-install-id'

# A Guard és a token-segéd a padló élesítése előtt legyen jelen.
foreach ($asset in 'exc_token.py', 'exc-guard', 'excellence-guard/plugin.yaml') {
  if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $asset) -PathType Leaf)) { Fail "Hiányzó telepítőfájl: $asset" }
}

# --- Python: a .cmd wrapper ezt indítja -I kapcsolóval -------------------------------------
if (-not $Python) {
  foreach ($candidate in 'py -3', 'python3', 'python') {
    $parts = $candidate -split ' '
    if (-not (Get-Command $parts[0] -ErrorAction SilentlyContinue)) { continue }
    $found = & $parts[0] @($parts | Select-Object -Skip 1) -c 'import sys; print(sys.executable)' 2>$null
    if ($LASTEXITCODE -eq 0 -and $found) { $Python = "$found".Trim(); break }
  }
}
if (-not $Python -or -not (Test-Path -LiteralPath $Python -PathType Leaf)) {
  Fail 'Nem találok Pythont. Telepíts gépszintű Python 3-at (minden felhasználónak), vagy add meg: -Python <python.exe útvonala>.'
}
& $Python -I -c 'import sys; sys.exit(sys.version_info < (3, 8))'
if ($LASTEXITCODE -ne 0) { Fail "Legalább Python 3.8 kell: $Python" }
if (-not $Testing) {
  # A munkatárs által írható Python kicserélhető lenne, és vele a Guard döntése is.
  $profiles = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList').ProfilesDirectory)
  if ($Python.StartsWith($profiles.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Fail "A Python a felhasználói mappában van ($Python). Telepíts gépszintű Pythont (pl. C:\Program Files), és add meg -Python kapcsolóval."
  }
  if ($Python -match '[^\x20-\x7E]') { Fail "A Python útvonala csak ASCII karaktert tartalmazhat: $Python" }
}

# --- Csomag ellenőrzése: hibás bemenet nem módosítja a régi padlót -----------------------
$Utf8 = New-Object Text.UTF8Encoding($false)
$Sha = [Security.Cryptography.SHA256]::Create()
function Hex([byte[]]$bytes) { -join ($Sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) }

try {
  $pkg = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $Package), $Utf8) | ConvertFrom-Json
  if ($pkg.platform -ne 'windows') { throw 'Ez nem Windows-csomag: töltsd le újra a platform=windows paraméterrel.' }
  if (-not ($pkg.installId -is [string]) -or -not $pkg.installId -or $pkg.files.'excellence-install-id' -ne "$($pkg.installId)`n") { throw 'Hibás installId' }
  $body = "excellence-managed-dir-v1`n"
  foreach ($name in $Names) {
    $text = $pkg.files.$name
    if (-not ($text -is [string]) -or -not $text.EndsWith("`n")) { throw "Hiányzó vagy hibás managed fájl: $name" }
    $body += "$name`n$(Hex $Utf8.GetBytes($text))`n"
  }
  if ($pkg.managedDirHash -ne (Hex $Utf8.GetBytes($body))) { throw 'A csomag hash-e nem egyezik a tartalommal' }
} catch {
  Fail "Hibás csomag, nem telepítem: $($_.Exception.Message)"
}

# Előre elhelyezett junction/symlink nem vezetheti máshová a rendszergazdai írást.
function Assert-NoReparse([string]$base, [string]$target) {
  $path = $target
  while ($path -and $path.Length -ge $base.Length) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { Fail "A telepítési útvonal nem lehet symlink vagy junction: $path" }
    $path = Split-Path -Parent $path
  }
  if (Test-Path -LiteralPath $target) {
    $bad = Get-ChildItem -LiteralPath $target -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | Select-Object -First 1
    if ($bad) { Fail "A telepítési könyvtár nem tartalmazhat symlinket vagy junctiont: $($bad.FullName)" }
  }
}

# --- Gépi könyvtár: csak SYSTEM és Administrators írhatja ---------------------------------
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Assert-NoReparse $Root $Root
if (-not $Testing) {
  # SID-ek, mert a csoportnevek a Windows nyelvétől függnek. A /reset leveszi a korábban
  # (akár a munkatárs által) beállított explicit jogokat, a gyökér jogát a gyerekek öröklik.
  & icacls $Root /setowner '*S-1-5-32-544' /T /C /Q | Out-Null
  & icacls $Root /reset /T /C /Q | Out-Null
  & icacls $Root /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-5-32-545:(OI)(CI)RX' /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "Nem sikerült a jogosultságot beállítani: $Root" }
}
New-Item -ItemType Directory -Force -Path $Managed, $Bin, $PluginRoot | Out-Null

$stage = Join-Path $Managed ('.stage-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  foreach ($name in $Names) { [IO.File]::WriteAllBytes((Join-Path $stage $name), $Utf8.GetBytes($pkg.files.$name)) }
  foreach ($name in $Names) { Move-Item -LiteralPath (Join-Path $stage $name) -Destination (Join-Path $Managed $name) -Force }
} finally {
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output $pkg.installId
Write-Output $pkg.managedDirHash

Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'exc_token.py') -Destination (Join-Path $Bin 'exc-token') -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'exc-guard') -Destination (Join-Path $Bin 'exc-guard') -Force
foreach ($tool in 'exc-token', 'exc-guard') {
  # A config.yaml ezeket hívja; a Windows nem ismeri a shebanget. A Hermes UTF-8-ként olvas.
  [IO.File]::WriteAllText((Join-Path $Bin "$tool.cmd"), "@`"$Python`" -I -X utf8 `"%~dp0$tool`" %*`r`n", [Text.Encoding]::ASCII)
}

function Copy-Plugin([string]$base, [string]$dest) {
  Assert-NoReparse $base $dest
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item -Path (Join-Path (Join-Path $PSScriptRoot 'excellence-guard') '*') -Destination $dest -Recurse -Force
}
Copy-Plugin $PluginRoot (Join-Path $PluginRoot 'excellence-guard')

# --- A munkatárs Hermes-profiljai: %LOCALAPPDATA%\hermes, profilonként saját plugin-mappa --
$HermesHome = ''
$Sid = ''
if ($Testing) {
  $HermesHome = Join-Path $Prefix 'home/AppData/Local/hermes'
} else {
  if (-not $User) { $User = (Get-CimInstance Win32_ComputerSystem).UserName }
  if ($User) {
    $Sid = (New-Object Security.Principal.NTAccount($User)).Translate([Security.Principal.SecurityIdentifier]).Value
    $profileDir = (Get-CimInstance Win32_UserProfile -Filter "SID='$Sid'").LocalPath
    if ($profileDir) { $HermesHome = Join-Path $profileDir 'AppData\Local\hermes' }
  }
}
if ($HermesHome) {
  Copy-Plugin $HermesHome (Join-Path $HermesHome 'plugins/excellence-guard')
  $profilesDir = Join-Path $HermesHome 'profiles'
  if (Test-Path -LiteralPath $profilesDir -PathType Container) {
    foreach ($botProfile in Get-ChildItem -LiteralPath $profilesDir -Directory -Force) {
      Copy-Plugin $HermesHome (Join-Path $botProfile.FullName 'plugins/excellence-guard')
    }
  }
} else {
  Write-Output 'Nem találtam bejelentkezett munkatársat: a Guard pluginját a -User kapcsolóval másold a profiljába.'
}

# --- A Hermes ebből tudja, hol a managed könyvtár -------------------------------------------
if (-not $Testing) {
  [Environment]::SetEnvironmentVariable('HERMES_MANAGED_DIR', $Managed, 'Machine')
  # A felhasználói változó felülírná a gépszintűt; a szerver a hash-eltérést úgyis elutasítja.
  $userEnv = "Registry::HKEY_USERS\$Sid\Environment"
  if ($Sid -and (Test-Path $userEnv) -and (Get-ItemProperty $userEnv).PSObject.Properties['HERMES_MANAGED_DIR']) {
    Remove-ItemProperty -Path $userEnv -Name 'HERMES_MANAGED_DIR'
    Write-Output 'A munkatárs saját HERMES_MANAGED_DIR beállítását eltávolítottam.'
  }
}

Write-Output "Gép-padló: $Managed"
Write-Output "Binárisok: $Bin"
$hermes = Get-Command hermes -ErrorAction SilentlyContinue
if ($hermes) {
  Write-Output '--- hermes config ---'
  $env:HERMES_MANAGED_DIR = $Managed
  & $hermes.Source config
} else {
  Write-Output 'A hermes nincs a PATH-on, az élő ellenőrzés (hermes config mutatja-e a managed kulcsokat) kimaradt.'
}
if (-not $Testing) { Write-Output 'A munkatárs jelentkezzen ki és be (vagy indítsa újra a gépet), hogy a Hermes lássa a HERMES_MANAGED_DIR-t.' }
