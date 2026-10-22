#!/usr/bin/env bash
# Проверка перед публикацией: в файлах, которые попадут в публичный репозиторий, нет личного и секретов.
# Личные шаблоны (имя, email, телефон, компании из опыта, суммы) — в .public-check-patterns: одна регулярка на строку,
# файл в git не попадает. Без него проверяются только секреты. Базы компаний EdTech / FinTech (публичные компании)
# этой проверкой не сканируются — в них по определению есть компании, куда подавался.
set -uo pipefail
cd "$(dirname "$0")/.."

files=$(git add -A --dry-run | sed "s/^add '//;s/'\$//")
fail=0
secrets='sk-ant-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY'
if hits=$(printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 grep -nIE "$secrets" 2>/dev/null); then
  echo "СЕКРЕТЫ:"; echo "$hits"; fail=1
fi
if [ -f .public-check-patterns ]; then
  pat=$(grep -vE '^\s*(#|$)' .public-check-patterns | paste -sd'|' -)
  if [ -n "$pat" ] && hits=$(printf '%s\n' "$files" | grep -vE '^(examples/demo/|job-search/(edtech|fintech)/)' | tr '\n' '\0' | xargs -0 grep -nIiE "$pat" 2>/dev/null); then
    echo "ЛИЧНОЕ:"; echo "$hits"; fail=1
  fi
else
  echo "нет .public-check-patterns — проверены только секреты"
fi
n=$(printf '%s\n' "$files" | grep -c .)
[ $fail = 0 ] && echo "чисто: $n файлов к публикации" || { echo "НЕ ПУБЛИКОВАТЬ: исправь найденное"; exit 1; }
