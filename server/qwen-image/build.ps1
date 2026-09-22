$ErrorActionPreference = 'Continue'
Set-Location (Join-Path $PSScriptRoot '..')
if (Test-Path .\qwen-image-build.exit) { Remove-Item .\qwen-image-build.exit }
docker compose --profile qwen-image build qwen-image *> .\qwen-image-build.log
$LASTEXITCODE | Out-File -Encoding ASCII .\qwen-image-build.exit
