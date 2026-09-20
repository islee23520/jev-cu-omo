$ErrorActionPreference = 'Stop'
$Root = 'E:\git\jev-cu-qwen'
$env:OLLAMA_HOST = '127.0.0.1:11435'
$env:OLLAMA_MODELS = Join-Path $Root 'models'
$env:OLLAMA_CONTEXT_LENGTH = '4096'
$env:OLLAMA_NUM_PARALLEL = '1'
$env:OLLAMA_MAX_LOADED_MODELS = '1'
$env:OLLAMA_FLASH_ATTENTION = '1'
New-Item -ItemType Directory -Force $env:OLLAMA_MODELS | Out-Null
$Ollama = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
$Server = Start-Process -FilePath $Ollama -ArgumentList 'serve' -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput "$Root\server.log" -RedirectStandardError "$Root\server-error.log"
$Server.Id | Set-Content "$Root\server.pid"
