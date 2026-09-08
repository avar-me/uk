#!/usr/bin/env bash
# Сборка статического сайта (профиль из profile.json).
#
# Использование:  ./build.sh
# Локальная проверка: python3 -m http.server -d docs 8000
#
# Источники данных — {av-xx,xx-av}.jsonl с sources.avar.me. Скачиваются
# во временные файлы, в репозитории JSONL не хранятся.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

DOCS="${ROOT}/docs"
TPL="${ROOT}/src/templates"
SOURCES_BASE="${SOURCES_BASE:-https://sources.avar.me/data}"

DICTS=()
while IFS= read -r dict; do
  [ -n "$dict" ] && DICTS+=("$dict")
done < <(python3 "$ROOT/src/apply_profile.py" --print-dicts)
if [ "${#DICTS[@]}" -lt 1 ]; then
  echo "build.sh: профиль не вернул словари" >&2
  exit 1
fi

echo "=== 1. Скачать словари с sources.avar.me ==="
for dict in "${DICTS[@]}"; do
  url="${SOURCES_BASE}/${dict}.jsonl"
  dest="${ROOT}/${dict}.jsonl"
  echo "  $url"
  curl -fsSL "$url" -o "$dest"
  wc -l "$dest"
done

echo ""
echo "=== 2. Очистка docs/ и копирование шаблонов ==="
rm -rf "$DOCS"
mkdir -p "$DOCS/tma"
cp "$TPL/html/index.html" "$TPL/html/app.js" "$TPL/html/styles.css" "$DOCS/"
cp "$TPL/html/phrases.html" "$TPL/html/phrases.js" "$DOCS/"
cp "$TPL/html/favicon.ico" "$TPL/html/favicon-32.png" "$TPL/html/favicon-192.png" "$DOCS/"
cp "$TPL/tma/index.html"  "$TPL/tma/app.js"  "$TPL/tma/styles.css"  "$DOCS/tma/"

echo ""
echo "=== 3. build_data.py ==="
for dict in "${DICTS[@]}"; do
  echo ""
  echo "--- $dict ---"
  DICTIONARY_JSONL="${ROOT}/${dict}.jsonl" DICT_NAME="$dict" DOCS_ROOT="$DOCS" \
    python3 "$ROOT/src/build_data.py"
done

echo ""
echo "=== 4. Профиль (цвета, подписи, cache-bust) ==="
python3 "$ROOT/src/apply_profile.py" --apply --docs "$DOCS"

if [ ! -f "$DOCS/index.html" ]; then
  echo "build.sh: docs/index.html не создан" >&2
  exit 1
fi

echo ""
echo "Готово. Локально:  python3 -m http.server -d docs 8000"
