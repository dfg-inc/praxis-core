<#
Praxis Approval Service - Windows installer. Run ELEVATED by the OWNER; Praxis tooling never runs it.
STATUS: UNTESTED. This script has never been executed on Windows by its author.

  .\install.ps1 -Check                  compatibility checks only
  .\install.ps1 -Install [-DryRun]      install, or upgrade when a previous version exists
  .\install.ps1 -Upgrade [-AllowDowngrade]
  .\install.ps1 -Backup | -Rollback | -Health | -EnrollCode
  .\install.ps1 -Uninstall [-Purge]
#>
[CmdletBinding()]
param(
  [switch]$Check, [switch]$Install, [switch]$Upgrade, [switch]$Backup, [switch]$Rollback, [switch]$Health,
  [switch]$EnrollCode, [switch]$Uninstall, [switch]$Purge, [switch]$DryRun, [switch]$AllowDowngrade
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Service = 'PraxisApproval'
$Account = "NT SERVICE\$Service"
$Code = Join-Path $env:ProgramFiles 'Praxis\ApprovalService'
$Base = Join-Path $env:ProgramData 'Praxis\ApprovalService'
$State = Join-Path $Base 'state'
$Config = Join-Path $Base 'config.json'
$Backups = Join-Path $Base 'backups'
$Pipe = '\\.\pipe\praxis-approval-service'
$Manifest = Get-Content (Join-Path $Here 'MANIFEST.json') -Raw | ConvertFrom-Json

function Die($m) { throw "praxis-approval-service: $m" }
function Do-Run([string]$what, [scriptblock]$block) { if ($DryRun) { Write-Host "DRY-RUN: $what" } else { & $block } }
function Assert-Admin {
  $p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Die 'run this from an elevated PowerShell (the owner''s administrator step)' }
}
function Set-Acl-Strict([string]$path, [string[]]$grants) {
  # inheritance removed; only the listed principals. icacls is used because it prints what it set.
  & icacls.exe $path /inheritance:r | Out-Null
  foreach ($g in $grants) { & icacls.exe $path /grant:r $g | Out-Null }
  if ($LASTEXITCODE -ne 0) { Die "could not set the ACL on $path" }
}

function Test-Compat {
  Assert-Admin
  if ([Environment]::OSVersion.Version.Major -lt 10) { Die 'Windows 10 or newer is required' }
  $arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $env:PROCESSOR_ARCHITECTURE } }
  if ($arch -ne $Manifest.windowsArch) { Die "this package is for $($Manifest.windowsArch), this machine is $arch" }
  foreach ($line in Get-Content (Join-Path $Here 'SHA256SUMS')) {
    $hash, $rel = $line -split '\s+', 2
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $Here $rel.Trim())).Hash.ToLower()
    if ($actual -ne $hash.ToLower()) { Die "package file $rel does not match SHA256SUMS; refusing" }
  }
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (-not (Test-Path $csc)) { Die 'the .NET Framework C# compiler (csc.exe) is required to build the service host' }
  $nodeVersion = & (Join-Path $Here 'payload\node\node.exe') --version
  if ($nodeVersion -notmatch '^v(2\d|[3-9]\d)\.') { Die "bundled Node $nodeVersion is older than v20" }
  $current = Join-Path $Code 'current'
  if (Test-Path $current) {
    $prev = Split-Path -Leaf (Get-Item $current).Target
    if ($prev -ne $Manifest.version -and -not $AllowDowngrade -and ([version]($Manifest.version -replace '-.*','') -lt [version]($prev -replace '-.*',''))) {
      Die "installed version $prev is newer than $($Manifest.version); use -AllowDowngrade"
    }
  }
  Write-Host "ok: Windows $arch, Node $nodeVersion, package $($Manifest.version) ($($Manifest.protocol))"
}

function Do-Backup {
  Assert-Admin
  if (-not (Test-Path $State)) { Write-Host 'nothing to back up'; return }
  New-Item -ItemType Directory -Force $Backups | Out-Null
  Set-Acl-Strict $Backups @('NT AUTHORITY\SYSTEM:(OI)(CI)F', 'BUILTIN\Administrators:(OI)(CI)F')
  $dest = Join-Path $Backups ("praxis-approval-{0}.zip" -f (Get-Date -Format 'yyyyMMddHHmmss'))
  Compress-Archive -Path $State, $Config -DestinationPath $dest -ErrorAction Stop
  Write-Host "backup: $dest"
}

function Do-Install {
  Test-Compat
  if ((Test-Path $State) -or (Test-Path (Join-Path $Code 'current'))) { Do-Backup }
  $version = $Manifest.version
  $target = Join-Path $Code $version
  $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  Do-Run "install code to $target" {
    New-Item -ItemType Directory -Force "$target.tmp\node" | Out-Null
    Copy-Item (Join-Path $Here 'payload\node\node.exe') "$target.tmp\node\node.exe"
    Copy-Item (Join-Path $Here 'payload\praxis-approval-service.mjs') "$target.tmp\praxis-approval-service.mjs"
    Copy-Item (Join-Path $Here 'MANIFEST.json') "$target.tmp\MANIFEST.json"
    & $csc /nologo /target:exe /out:"$target.tmp\PraxisApprovalServiceHost.exe" /reference:System.ServiceProcess.dll (Join-Path $Here 'ServiceHost.cs')
    if ($LASTEXITCODE -ne 0) { Die 'compiling the service host failed' }
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Move-Item "$target.tmp" $target
  }
  Do-Run 'register the service under its virtual account' {
    if (-not (Get-Service $Service -ErrorAction SilentlyContinue)) {
      & sc.exe create $Service binPath= "`"$Code\current\PraxisApprovalServiceHost.exe`"" obj= $Account start= auto DisplayName= 'Praxis Approval Service' | Out-Null
      & sc.exe sidtype $Service unrestricted | Out-Null
      & sc.exe failure $Service reset= 86400 actions= restart/5000/restart/5000/restart/30000 | Out-Null
    } else { Stop-Service $Service -ErrorAction SilentlyContinue }
  }
  Do-Run 'protect directories' {
    New-Item -ItemType Directory -Force $State, (Join-Path $Base 'logs') | Out-Null
    Set-Acl-Strict $Base @('NT AUTHORITY\SYSTEM:(OI)(CI)F', 'BUILTIN\Administrators:(OI)(CI)F', "${Account}:(RX)")
    Set-Acl-Strict $State @('NT AUTHORITY\SYSTEM:(OI)(CI)F', 'BUILTIN\Administrators:(OI)(CI)F', "${Account}:(OI)(CI)M")
    Set-Acl-Strict $Code @('NT AUTHORITY\SYSTEM:(OI)(CI)F', 'BUILTIN\Administrators:(OI)(CI)F', "${Account}:(OI)(CI)RX", 'BUILTIN\Users:(OI)(CI)RX')
    if (-not (Test-Path $Config)) {
      @{ mode = 'production'; principal = $Account; repositories = @(); operator = @{ port = 8780; origin = 'http://localhost:8780' } } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $Config
      Set-Acl-Strict $Config @('NT AUTHORITY\SYSTEM:F', 'BUILTIN\Administrators:F', "${Account}:R")
    }
    $link = Join-Path $Code 'current'
    $previous = if (Test-Path $link) { (Get-Item $link).Target } else { $null }
    if ($previous) { Set-Content (Join-Path $Code '.previous') $previous }
    if (Test-Path $link) { (Get-Item $link).Delete() }
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Start-Service $Service
  }
  Write-Host "installed $version. Next: .\install.ps1 -Health, then enroll an authenticator (docs/approval-service/INSTALL.md)."
}

function Do-Health {
  $node = Join-Path $Code 'current\node\node.exe'
  $out = & $node (Join-Path $Code 'current\praxis-approval-service.mjs') health --endpoint $Pipe
  if ($LASTEXITCODE -ne 0) { Die "the service does not answer on $Pipe" }
  $json = $out | ConvertFrom-Json
  if ($json.health.mode -ne 'production') { Die 'not in production mode' }
  if (-not $json.health.isolation.verified) { Die 'isolation is not verified' }
  if (-not $json.health.integrity.ok) { Die 'integrity problem reported' }
  # the pipe's owner and DACL, read independently of the service
  $acl = (Get-Acl $Pipe).Access | ForEach-Object { "$($_.IdentityReference):$($_.AccessControlType)" }
  if (-not ($acl -match 'NT AUTHORITY\\NETWORK:Deny')) { Die 'the pipe does not deny network access' }
  Write-Host 'healthy'
}

function Do-Rollback {
  Assert-Admin
  $prevFile = Join-Path $Code '.previous'
  if (-not (Test-Path $prevFile)) { Die 'no previous version recorded' }
  $prev = (Get-Content $prevFile).Trim()
  if (-not $prev.StartsWith($Code) -or -not (Test-Path $prev)) { Die 'the recorded previous version is missing or outside the install directory' }
  Stop-Service $Service
  $link = Join-Path $Code 'current'
  Set-Content $prevFile (Get-Item $link).Target
  (Get-Item $link).Delete()
  New-Item -ItemType Junction -Path $link -Target $prev | Out-Null
  Start-Service $Service
  Write-Host "rolled back to $prev"
}

function Do-Uninstall {
  Assert-Admin
  Do-Backup
  Stop-Service $Service -ErrorAction SilentlyContinue
  & sc.exe delete $Service | Out-Null
  Remove-Item -Recurse -Force $Code
  if ($Purge) {
    Remove-Item -Recurse -Force $State, $Config, (Join-Path $Base 'logs') -ErrorAction SilentlyContinue
    Write-Host "purged state and configuration; backups remain in $Backups (Administrators only)"
  } else { Write-Host "removed the service and code; state, configuration and backups remain in $Base" }
}

if ($Check) { Test-Compat }
elseif ($Install -or $Upgrade) { Do-Install }
elseif ($Backup) { Do-Backup }
elseif ($Rollback) { Do-Rollback }
elseif ($Health) { Do-Health }
elseif ($EnrollCode) { Assert-Admin; & (Join-Path $Code 'current\node\node.exe') (Join-Path $Code 'current\praxis-approval-service.mjs') enroll-code --config $Config }
elseif ($Uninstall) { Do-Uninstall }
else { Get-Help $MyInvocation.MyCommand.Path | Out-Host }
