#!/usr/bin/env bash
set -e

REPO="https://github.com/akshaymaru/miii-cli"   # update this when you publish
BIN_DIR="${HOME}/.local/bin"
BIN_NAME="miii"

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac

ASSET="${BIN_NAME}-${OS}-${ARCH}"

echo "downloading ${ASSET}..."
mkdir -p "$BIN_DIR"
curl -fsSL "${REPO}/releases/latest/download/${ASSET}" -o "${BIN_DIR}/${BIN_NAME}"
chmod +x "${BIN_DIR}/${BIN_NAME}"

echo ""
echo "installed → ${BIN_DIR}/${BIN_NAME}"
echo ""
echo "make sure ${BIN_DIR} is in your PATH:"
echo "  echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.zshrc"
