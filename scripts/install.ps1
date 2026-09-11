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
# BJavaDecompiler installer (Windows PowerShell).
# Checks prerequisites, installs npm dependencies, creates .env from .env.example if missing,
# and builds the TypeScript sources. Safe to re-run - never overwrites an existing .env.

Set-Location (Join-Path $PSScriptRoot "..")

Write-Host "BJavaDecompiler installer"
Write-Host ""

$missing = $false

function Check-Tool($name, $help) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host "  MISSING: $name - $help"
        $script:missing = $true
    } else {
        Write-Host "  found: $name ($($cmd.Source))"
    }
}

Write-Host "Checking prerequisites..."
Check-Tool "node" "Node.js 18+ - https://nodejs.org"
Check-Tool "java" "JDK 17+ (required by Vineflower/jd-cli/JADX/Procyon and to run mvn) - must be on PATH"
Check-Tool "mvn" "Apache Maven (used for the recompilation-verification step) - must be on PATH"
Write-Host ""

if ($missing) {
    Write-Host "Install the missing prerequisite(s) above, then re-run this script."
    exit 1
}

Write-Host "Installing npm dependencies..."
npm install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not (Test-Path ".env")) {
    Copy-Item ".env.example" ".env"
    Write-Host "Created .env from .env.example - edit it to set your AI provider (Ollama Cloud API key, or"
    Write-Host "AI_PROVIDER=ollama-local for a local Ollama install) before your first job."
} else {
    Write-Host ".env already exists - leaving it untouched."
}

Write-Host "Building..."
npm run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ""
Write-Host "Done. Run 'npm start' (or 'npm run dev' for auto-reload during development), then open"
Write-Host "http://localhost:7795 - visit Tool Setup and install the decompiler engines on first use."
