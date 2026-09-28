# Installs the idle-compactor Claude Code plugin with automatic updates (Windows).
#
#   irm https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/install.ps1 | iex
#
# 1. Adds this repository as a Claude Code plugin marketplace and installs the
#    plugin for your user, so every terminal and desktop Code-tab session
#    loads it.
# 2. Turns on auto-update for the marketplace in ~/.claude/settings.json, so
#    each new push to the repository reaches you on your next session start.
# 3. Sets CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 in the same file's "env": the
#    plugin API the compactor uses is early access and off by default.
#
# Safe to run again: it repairs or refreshes an existing install.
# Works in Windows PowerShell 5.1 and PowerShell 7. Errors are thrown rather
# than calling exit, so a failure under `irm | iex` doesn't close the window.

& {
$ErrorActionPreference = 'Stop'

$Repo = 'intenex/claude-idle-compactor'
$Marketplace = 'claude-idle-compactor'
$Plugin = "idle-compactor@$Marketplace"
$ConfigDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$Settings = Join-Path $ConfigDir 'settings.json'

function Fail($message) { throw "idle-compactor install failed: $message" }

# The claude CLI if it is installed, else the copy the Claude desktop app
# bundles (newest version first).
function Find-Claude {
  $cmd = Get-Command claude -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd) { return $cmd.Source }
  $local = Join-Path $HOME '.local\bin\claude.exe'
  if (Test-Path $local) { return $local }
  $bundled = Join-Path $env:APPDATA 'Claude\claude-code'
  if (Test-Path $bundled) {
    $versions = Get-ChildItem $bundled -Directory |
      Where-Object { $_.Name -match '^\d+(\.\d+)*$' } |
      Sort-Object { [version]$_.Name } -Descending
    foreach ($v in $versions) {
      $exe = Join-Path $v.FullName 'claude.exe'
      if (Test-Path $exe) { return $exe }
    }
  }
  return $null
}

# Native commands run with 'Continue': under 'Stop', Windows PowerShell 5.1
# turns anything they write to stderr into a terminating error.
function Invoke-Claude {
  $ErrorActionPreference = 'Continue'
  & $Claude @args 2>&1 | ForEach-Object { "$_" } | Out-Host
  return ($LASTEXITCODE -eq 0)
}

function Get-ClaudeOutput {
  $ErrorActionPreference = 'Continue'
  return (& $Claude @args 2>$null | Out-String)
}

$Claude = Find-Claude
if (-not $Claude) { Fail 'Claude Code was not found. Install the Claude desktop app or Claude Code first.' }
$version = (Get-ClaudeOutput --version).Trim()
Write-Host "Using Claude Code at: $Claude ($version)"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'git is required to fetch the plugin. Install it from https://git-scm.com/download/win or run: winget install Git.Git'
}

# 1. Marketplace and plugin.
if ((Get-ClaudeOutput plugin marketplace list) -match [regex]::Escape($Marketplace)) {
  Write-Host "Refreshing the $Marketplace marketplace..."
  Invoke-Claude plugin marketplace update $Marketplace | Out-Null
} else {
  Write-Host "Adding the $Marketplace marketplace..."
  if (-not (Invoke-Claude plugin marketplace add $Repo)) { Fail "could not add the $Marketplace marketplace" }
}

Write-Host "Installing $Plugin..."
if (-not (Invoke-Claude plugin install $Plugin --scope user)) {
  if (-not (Invoke-Claude plugin update $Plugin --scope user)) { Fail "could not install $Plugin" }
}
Get-ClaudeOutput plugin enable $Plugin --scope user | Out-Null  # fails harmlessly if already enabled

# 2 and 3. Settings: auto-update for the marketplace, and the function-hooks
# switch. The previous file is kept as a backup.
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$settingsObj = [pscustomobject]@{}
if (Test-Path $Settings) {
  $backup = "$Settings.bak-idle-compactor-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  Copy-Item $Settings $backup
  Write-Host "Backed up settings to $backup"
  $text = [IO.File]::ReadAllText($Settings)
  if ($text.Trim()) {
    try { $settingsObj = $text | ConvertFrom-Json }
    catch { Fail "settings.json is not valid JSON; fix it and run the installer again ($_)" }
  }
}

# Returns $obj.$name, creating it as an empty object if it is missing.
function Get-Child($obj, $name) {
  if ($null -eq $obj.$name) { $obj | Add-Member -NotePropertyName $name -NotePropertyValue ([pscustomobject]@{}) -Force }
  return $obj.$name
}

$envObj = Get-Child $settingsObj 'env'
$envObj | Add-Member -NotePropertyName 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS' -NotePropertyValue '1' -Force

$known = Get-Child $settingsObj 'extraKnownMarketplaces'
$entry = Get-Child $known $Marketplace
$entry | Add-Member -NotePropertyName 'source' -NotePropertyValue ([pscustomobject]@{ source = 'github'; repo = $Repo }) -Force
$entry | Add-Member -NotePropertyName 'autoUpdate' -NotePropertyValue $true -Force

$enabled = Get-Child $settingsObj 'enabledPlugins'
$enabled | Add-Member -NotePropertyName $Plugin -NotePropertyValue $true -Force

# UTF-8 without a BOM: Windows PowerShell 5.1's Set-Content would add one.
$json = $settingsObj | ConvertTo-Json -Depth 100
[IO.File]::WriteAllText($Settings, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
Write-Host "Updated $Settings (auto-update on, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1)"

if (-not ((Get-ClaudeOutput plugin list) -match 'idle-compactor')) {
  Fail "the plugin does not appear in 'claude plugin list'"
}

Write-Host ''
Write-Host 'idle-compactor is installed.'
Write-Host "New Claude Code sessions (terminal and the desktop app's Code tab) load it;"
Write-Host 'sessions that are already open pick it up when restarted.'
Write-Host 'In a session, /idle-compactor shows its status. Updates install automatically.'
}
