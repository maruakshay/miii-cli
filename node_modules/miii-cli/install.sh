#!/usr/bin/env bash
set -e
npm install
npm run build
npm link
echo "miii installed. Run: miii"
