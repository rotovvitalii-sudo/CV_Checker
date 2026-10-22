#!/usr/bin/env bash
# Бэкап личных данных в отдельный приватный репозиторий (публичный репозиторий их не видит — .gitignore).
# Второй git-каталог .git-data с тем же рабочим каталогом; отслеживаются только пути из DATA_PATHS.
# Первый запуск: DATA_REMOTE=https://github.com/<you>/cv-checker-data.git scripts/backup-data.sh
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_PATHS=(knowledge-base vacancies output Master_CV.pdf job-fit-search-brief.md CLAUDE.local.md
  job-search/corpus job-search/candidates job-search/digests job-search/signals.md
  web/data/applications.json web/data/targets.json web/data/week.json web/data/limit.json web/data/budget.json
  web/data/job-sites.json web/data/agent-models.json web/data/case-suggestions.json web/data/feed-skipped.json
  .public-check-patterns)
g() { git --git-dir=.git-data --work-tree=. "$@"; }

if [ ! -d .git-data ]; then
  git init -q --bare .git-data
  g config status.showUntrackedFiles no
  g config core.excludesFile /dev/null
  g branch -M main 2>/dev/null || true
fi
if [ -n "${DATA_REMOTE:-}" ] && ! g remote get-url origin >/dev/null 2>&1; then g remote add origin "$DATA_REMOTE"; fi

existing=()
for p in "${DATA_PATHS[@]}"; do [ -e "$p" ] && existing+=("$p"); done
# -f: личные пути исключены публичным .gitignore, здесь их добавляем явно; логи агента не берём
g add -f -- "${existing[@]}"
g reset -q -- '*.log' 2>/dev/null || true
if g diff --cached --quiet; then echo "изменений нет"; else g commit -q -m "backup $(date '+%Y-%m-%d %H:%M')"; echo "закоммичено"; fi
g remote get-url origin >/dev/null 2>&1 && g push -q -u origin main && echo "отправлено в $(g remote get-url origin)" || echo "remote не задан — только локальный коммит"
