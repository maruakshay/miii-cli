#!/usr/bin/env sh
# miii installer / updater
#
#   curl -fsSL https://raw.githubusercontent.com/maruakshay/miii-cli/main/install.sh | sh
#
# Re-run any time to update to the latest release.
set -eu

PKG="miii-agent"
GREEN="$(printf '\033[32m')"; YELLOW="$(printf '\033[33m')"; RED="$(printf '\033[31m')"; DIM="$(printf '\033[2m')"; RESET="$(printf '\033[0m')"

info()  { printf '%s\n' "${GREEN}==>${RESET} $*"; }
warn()  { printf '%s\n' "${YELLOW}!!${RESET} $*" >&2; }
die()   { printf '%s\n' "${RED}xx${RESET} $*" >&2; exit 1; }

# --- Node ---
command -v node >/dev/null 2>&1 || die "Node.js not found. Install Node >= 18 from https://nodejs.org"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 18 ] || die "Node >= 18 required (found $(node -v)). Upgrade from https://nodejs.org"

# --- npm ---
command -v npm >/dev/null 2>&1 || die "npm not found. It ships with Node.js — reinstall from https://nodejs.org"

# Detect install vs update for nicer messaging.
if npm ls -g "$PKG" >/dev/null 2>&1; then
  info "Updating ${PKG} to the latest release…"
else
  info "Installing ${PKG}…"
fi

# Global installs may need sudo when the npm prefix isn't user-writable.
if npm i -g "${PKG}@latest" 2>/dev/null; then
  :
elif command -v sudo >/dev/null 2>&1; then
  warn "Global install needs elevated permissions — retrying with sudo."
  sudo npm i -g "${PKG}@latest"
else
  die "Install failed and sudo is unavailable. Fix your npm prefix or run as a user that can write to it."
fi

VERSION="$(miii --version 2>/dev/null || npm view "$PKG" version 2>/dev/null || echo '')"
info "Done.${VERSION:+ ${DIM}($PKG $VERSION)${RESET}}"

# --- Ollama hint ---
if ! command -v ollama >/dev/null 2>&1; then
  warn "Ollama not detected. miii needs a local model server."
  printf '%s\n' "${DIM}   Install: https://ollama.com/download${RESET}"
  printf '%s\n' "${DIM}   Then:    ollama pull qwen2.5-coder:14b${RESET}"
fi

printf '\n%s\n' "Run ${GREEN}miii${RESET} to start."
