$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$ExitCode = 1
Start-Transcript -Path "$PSScriptRoot\docker-stage.log" -Force
try {
  # Independent copy: Docker never mounts or modifies the native rollback store.
  $Manifest = 'manifests\registry.ollama.ai\library\qwen3\8b'
  $Source = Join-Path $PSScriptRoot 'models'
  $Destination = Join-Path $PSScriptRoot 'docker-data\models'
  $Model = Get-Content (Join-Path $Source $Manifest) -Raw | ConvertFrom-Json
  New-Item -ItemType Directory -Force "$Destination\blobs" | Out-Null
  foreach ($Blob in (@($Model.config) + @($Model.layers))) {
    $Name = $Blob.digest.Replace(':', '-')
    $Target = Join-Path "$Destination\blobs" $Name
    if (-not (Test-Path $Target)) {
      Copy-Item (Join-Path "$Source\blobs" $Name) $Target
    }
    $Hash = (Get-FileHash $Target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ("sha256:$Hash" -ne $Blob.digest) { throw "Blob hash mismatch: $Name" }
    Write-Output "Verified $Name"
  }
  New-Item -ItemType Directory -Force (Split-Path (Join-Path $Destination $Manifest)) | Out-Null
  Copy-Item (Join-Path $Source $Manifest) (Join-Path $Destination $Manifest)
  $env:QWEN_PORT = '11436'
  & docker compose -f compose.yaml pull
  if ($LASTEXITCODE -ne 0) { throw "Image pull failed: $LASTEXITCODE" }
  & docker compose -f compose.yaml up -d --wait --wait-timeout 180
  if ($LASTEXITCODE -ne 0) { throw "Staging failed: $LASTEXITCODE" }
  $ExitCode = 0
} catch {
  Write-Output ($_ | Out-String)
} finally {
  Stop-Transcript
  $ExitCode | Set-Content "$PSScriptRoot\docker-stage.exit"
}
exit $ExitCode
