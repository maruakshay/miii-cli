#!/usr/bin/env pwsh
# miii installer / updater (Windows)
#
#   irm https://raw.githubusercontent.com/maruakshay/miii-cli/main/install.ps1 | iex
#
# Re-run any time to update to the latest release.
$ErrorActionPreference = 'Stop'
$Pkg = 'miii-agent'

function Info($m) { Write-Host "==> $m" -ForegroundColor Green }
function Warn($m) { Write-Host "!! $m"  -ForegroundColor Yellow }
function Die($m)  { Write-Host "xx $m"  -ForegroundColor Red; exit 1 }

# --- Node ---
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Die "Node.js not found. Install Node >= 18 from https://nodejs.org"
}
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 18) { Die "Node >= 18 required (found $(node -v)). Upgrade from https://nodejs.org" }

# --- npm ---
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Die "npm not found. It ships with Node.js -- reinstall from https://nodejs.org"
}

# Detect install vs update for nicer messaging.
npm ls -g $Pkg *> $null
if ($LASTEXITCODE -eq 0) { Info "Updating $Pkg to the latest release..." }
else                     { Info "Installing $Pkg..." }

npm i -g "$Pkg@latest"
if ($LASTEXITCODE -ne 0) {
  Warn "Global install failed -- usually a permissions or npm-prefix issue."
  Write-Host "   Fix option A: run this shell as Administrator and re-run."
  Write-Host "   Fix option B: use a user-writable npm prefix, then re-run:"
  Write-Host "     npm config set prefix `"$env:APPDATA\npm`""
  Write-Host "     # ensure %APPDATA%\npm is on your PATH"
  Die "Install failed."
}

$version = try { miii --version 2>$null } catch { '' }
if ($version) { Info "Done. ($Pkg $version)" } else { Info "Done." }

# --- Ollama hint ---
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Warn "Ollama not detected. miii needs a local model server."
  Write-Host "   Install: https://ollama.com/download"
  Write-Host "   Then:    ollama pull qwen2.5-coder:14b"
}

Write-Host ""
Write-Host "Run miii to start." -ForegroundColor Green
