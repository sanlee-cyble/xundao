#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

command -v node >/dev/null 2>&1 || { echo "缺少 Node.js，请先安装 Node.js 22 或更高版本。"; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "缺少 Python 3，请先安装 Python 3.9 或更高版本。"; exit 1; }

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "当前 Node.js 版本过低；寻达需要 Node.js 22 或更高版本。"
  exit 1
fi

python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' || {
  echo "当前 Python 版本过低；寻达需要 Python 3.9 或更高版本。"
  exit 1
}

npm ci
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt

if [ ! -f .env.local ]; then
  cp .env.local.example .env.local
fi

echo "本地依赖已安装。运行 npm run web:local，然后打开 http://127.0.0.1:8731。"
