param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$presetIds = @('adaptive-native-standard', 'adaptive-native-minimal')
$targetRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.agent-presets'))
$backupRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.preset-backups'))
$targetPrefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$removed = 0

foreach ($presetId in $presetIds) {
  $target = [IO.Path]::GetFullPath((Join-Path $targetRoot $presetId))
  if (-not $target.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to uninstall outside the preset root: $target"
  }
  if (-not (Test-Path -LiteralPath $target -PathType Container)) {
    Write-Host "Preset is not installed: $target"
    continue
  }

  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $backup = Join-Path $backupRoot "$presetId-uninstalled-$stamp"
  if (Test-Path -LiteralPath $backup) {
    $backup = Join-Path $backupRoot "$presetId-uninstalled-$stamp-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
  }
  Move-Item -LiteralPath $target -Destination $backup
  Write-Host "Uninstalled to recoverable backup: $backup" -ForegroundColor Green
  $removed += 1
}

if ($removed -eq 0) { Write-Host 'Neither Adaptive Native preset was installed.' }
Write-Host 'Restart DSH to refresh the preset roster.' -ForegroundColor Yellow
