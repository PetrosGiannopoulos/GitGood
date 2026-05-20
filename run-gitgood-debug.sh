#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
if [ ! -d "node_modules" ]; then npm install; fi
echo "Launching GitGood in DEBUG mode (DevTools open)..."
npx electron . --dev
