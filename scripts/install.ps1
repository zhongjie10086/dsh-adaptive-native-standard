param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$sharedPluginSource = [IO.Path]::GetFullPath((Join-Path $projectRoot 'preset'))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.agent-presets'))
$backupRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.preset-backups'))
$targetPrefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$definitions = @(
  @{ Id = 'adaptive-native-standard'; Source = (Join-Path $projectRoot 'preset'); InheritPlugins = $false },
  @{ Id = 'adaptive-native-minimal'; Source = (Join-Path $projectRoot 'preset-minimal'); InheritPlugins = $true }
)

foreach ($definition in $definitions) {
  foreach ($required in @('agent.cordis.yml', 'preset.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $definition.Source $required) -PathType Leaf)) {
      throw "Incomplete preset source; missing $required under $($definition.Source)"
    }
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $sharedPluginSource 'tool-bootstrap.mjs') -PathType Leaf)) {
  throw "Incomplete shared plugin source: $sharedPluginSource"
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
foreach ($definition in $definitions) {
  $presetId = $definition.Id
  $source = [IO.Path]::GetFullPath($definition.Source)
  $target = [IO.Path]::GetFullPath((Join-Path $targetRoot $presetId))
  if (-not $target.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to install outside the preset root: $target"
  }
  if ((Test-Path -LiteralPath $target) -and -not $Update) {
    throw "Preset already exists: $target. Re-run with -Update to back up and replace both presets."
  }

  $staging = [IO.Path]::GetFullPath((Join-Path $targetRoot ".$presetId.staging-$([guid]::NewGuid().ToString('N'))"))
  if (-not $staging.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to stage outside the preset root: $staging"
  }
  Copy-Item -LiteralPath $source -Destination $staging -Recurse
  if ($definition.InheritPlugins) {
    Get-ChildItem -LiteralPath $sharedPluginSource -File -Filter '*.mjs' |
      ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $staging }
  }

  $backup = $null
  try {
    if (Test-Path -LiteralPath $target) {
      New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
      $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
      $backup = Join-Path $backupRoot "$presetId-$stamp"
      if (Test-Path -LiteralPath $backup) {
        $backup = Join-Path $backupRoot "$presetId-$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
      }
      Move-Item -LiteralPath $target -Destination $backup
    }
    Move-Item -LiteralPath $staging -Destination $target
  } catch {
    if ((-not (Test-Path -LiteralPath $target)) -and $null -ne $backup -and (Test-Path -LiteralPath $backup)) {
      Move-Item -LiteralPath $backup -Destination $target
    }
    throw
  } finally {
    if (Test-Path -LiteralPath $staging) {
      Remove-Item -LiteralPath $staging -Recurse -Force
    }
  }

  Write-Host "Installed: $target" -ForegroundColor Green
  if ($null -ne $backup) { Write-Host "Previous version: $backup" }
}

Write-Host 'Restart `pnpm dsh web`, create a new session, then select Adaptive Native Standard or Adaptive Native Minimal.' -ForegroundColor Yellow
