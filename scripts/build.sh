#!/bin/bash
# PPT 工作室构建：免 tsc —— src → lib 复制（见 build.mjs）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node scripts/build.mjs
echo "=== Build complete ==="
