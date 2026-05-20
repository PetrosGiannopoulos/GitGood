#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies for the first time..."
  if ! command -v npm >/dev/null 2>&1; then
    echo "Error: Node.js is not installed. Please install Node.js 18+ from https://nodejs.org"
    exit 1
  fi
  npm install
fi

npm start
