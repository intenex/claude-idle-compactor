# Removes the idle-compactor plugin, its marketplace, and the settings the
# installer added (auto-update entry, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS). Windows.
#
#   irm https://raw.githubusercontent.com/intenex/claude-idle-compactor/main/uninstall.ps1 | iex

& {
$ErrorActionPreference = 'Stop'

$Marketplace = 'claude-idle-compactor'
$Plugin = "idle-compactor@$Marketplace"
$ConfigDir = if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $HOME '.claude' }
$Settings = Join-Path $ConfigDir 'settings.json'

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
}

$Claude = Find-Claude
if ($Claude) {
  Invoke-Claude plugin uninstall $Plugin --scope user
  Invoke-Claude plugin marketplace remove $Marketplace
}

if (Test-Path $Settings) {
  Copy-Item $Settings "$Settings.bak-idle-compactor-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  $settingsObj = [IO.File]::ReadAllText($Settings) | ConvertFrom-Json
  if ($settingsObj.env) { $settingsObj.env.PSObject.Properties.Remove('CLAUDE_CODE_ENABLE_FUNCTION_HOOKS') }
  if ($settingsObj.extraKnownMarketplaces) { $settingsObj.extraKnownMarketplaces.PSObject.Properties.Remove($Marketplace) }
  if ($settingsObj.enabledPlugins) { $settingsObj.enabledPlugins.PSObject.Properties.Remove($Plugin) }
  $json = $settingsObj | ConvertTo-Json -Depth 100
  [IO.File]::WriteAllText($Settings, $json + "`n", (New-Object System.Text.UTF8Encoding $false))
}

Write-Host 'idle-compactor is uninstalled. Sessions already open keep it until they restart.'
}
