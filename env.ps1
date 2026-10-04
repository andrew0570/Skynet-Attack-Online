# Project-local toolchain. Dot-source in a PowerShell terminal:  . .\env.ps1
# (VS Code terminals opened in this workspace get the same PATH via .vscode/settings.json.)
$tools = Join-Path $PSScriptRoot ".tools"
$env:PATH = "$tools\bin;$tools\node-v24.21.0-win-x64;$env:PATH"
$env:npm_config_cache = "$tools\npm-cache"
Write-Host "SAO toolchain: node $(node --version), spacetime -> .tools\spacetime-root"
