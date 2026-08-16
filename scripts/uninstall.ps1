param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' })
)

$ErrorActionPreference = 'Stop'
$presetId = 'adaptive-native-standard'
$targetRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.agent-presets'))
$target = [IO.Path]::GetFullPath((Join-Path $targetRoot $presetId))
$backupRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.preset-backups'))
$targetPrefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $target.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to uninstall outside the preset root: $target"
}
if (-not (Test-Path -LiteralPath $target -PathType Container)) {
  Write-Host "Preset is not installed: $target"
  exit 0
}

New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $backupRoot "$presetId-uninstalled-$stamp"
Move-Item -LiteralPath $target -Destination $backup
Write-Host "Uninstalled to recoverable backup: $backup" -ForegroundColor Green
Write-Host 'Restart DSH to refresh the preset roster.' -ForegroundColor Yellow
