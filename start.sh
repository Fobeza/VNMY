#!/usr/bin/env sh
# Локальный сервер для движка: ./start.sh [порт]
PORT="${1:-8000}"
cd "$(dirname "$0")" || exit 1
echo "VNMY → http://localhost:$PORT"
if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
else
  echo "Нужен python3 или node (npx serve) — либо загрузите папку на статический хостинг."
  exit 1
fi
