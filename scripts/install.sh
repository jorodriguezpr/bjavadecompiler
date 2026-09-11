#!/usr/bin/env bash
#
# BJavaDecompiler
# Copyright 2026 Jose Rodriguez <jrpcone@gmail.com>
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# Developer: Jose Rodriguez <jrpcone@gmail.com>
#
# BJavaDecompiler installer (Linux/macOS).
# Checks prerequisites, installs npm dependencies, creates .env from .env.example if missing,
# and builds the TypeScript sources. Safe to re-run — never overwrites an existing .env.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "BJavaDecompiler installer"
echo

missing=0
check() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "  MISSING: $1 — $2"
    missing=1
  else
    echo "  found: $1 ($("$1" "$3" 2>&1 | head -n1))"
  fi
}

echo "Checking prerequisites..."
check node "Node.js 18+ — https://nodejs.org" --version
check java "JDK 17+ (required by Vineflower/jd-cli/JADX/Procyon and to run mvn) — must be on PATH" -version
check mvn "Apache Maven (used for the recompilation-verification step) — must be on PATH" --version
echo

if [ "$missing" -eq 1 ]; then
  echo "Install the missing prerequisite(s) above, then re-run this script."
  exit 1
fi

echo "Installing npm dependencies..."
npm install

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it to set your AI provider (Ollama Cloud API key, or"
  echo "AI_PROVIDER=ollama-local for a local Ollama install) before your first job."
else
  echo ".env already exists — leaving it untouched."
fi

echo "Building..."
npm run build

echo
echo "Done. Run 'npm start' (or 'npm run dev' for auto-reload during development), then open"
echo "http://localhost:7795 — visit Tool Setup and install the decompiler engines on first use."
