param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }),
  [switch]$Update
)

$ErrorActionPreference = 'Stop'
$presetId = 'adaptive-native-standard'
$projectRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$source = [IO.Path]::GetFullPath((Join-Path $projectRoot 'preset'))
$targetRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.agent-presets'))
$target = [IO.Path]::GetFullPath((Join-Path $targetRoot $presetId))
$backupRoot = [IO.Path]::GetFullPath((Join-Path $DshHome '.preset-backups'))
$targetPrefix = $targetRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar

if (-not $target.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to install outside the preset root: $target"
}
foreach ($required in @('agent.cordis.yml', 'preset.yml', 'direct-bash.mjs')) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $required) -PathType Leaf)) {
    throw "Incomplete preset source; missing $required under $source"
  }
}

New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
if ((Test-Path -LiteralPath $target) -and -not $Update) {
  throw "Preset already exists: $target. Re-run with -Update to back it up and replace it."
}

$staging = [IO.Path]::GetFullPath((Join-Path $targetRoot ".$presetId.staging-$([guid]::NewGuid().ToString('N'))"))
if (-not $staging.StartsWith($targetPrefix, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to stage outside the preset root: $staging"
}
Copy-Item -LiteralPath $source -Destination $staging -Recurse

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
Write-Host 'Restart `pnpm dsh web`, create a new session, then select Adaptive Native Standard.' -ForegroundColor Yellow
