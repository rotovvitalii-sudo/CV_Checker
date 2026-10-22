#!/usr/bin/env bash
# Демо-кандидат на чистом клоне: копирует examples/demo/ на место личных папок.
# Ничего не перезаписывает — если папка уже есть (твои данные), она пропускается.
set -euo pipefail
cd "$(dirname "$0")/.."

for item in knowledge-base vacancies job-fit-search-brief.md; do
  if [ -e "$item" ]; then
    echo "пропускаю $item — уже есть"
  else
    cp -R "examples/demo/$item" "$item"
    echo "скопировал examples/demo/$item → $item"
  fi
done
# Готовый пакет (CV, письмо, отчёты) и статусы заявок с оценкой фита — только если своих ещё нет
if [ -e output ]; then echo "пропускаю output — уже есть"; else cp -R examples/demo/output output; echo "скопировал examples/demo/output → output"; fi
mkdir -p web/data
if [ -e web/data/applications.json ]; then echo "пропускаю web/data/applications.json — уже есть"
else cp examples/demo/web-data/applications.json web/data/applications.json; echo "скопировал статусы заявок → web/data/applications.json"; fi
echo "Готово. Запуск: npm run app → http://127.0.0.1:4317"
