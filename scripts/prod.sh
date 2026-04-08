#!/usr/bin/env bash
# prod.sh — сборка и запуск prod-окружения
# Backend: node dist/server.js
# Frontend: статика через vite preview (или отдаётся с nginx — см. README)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- цвета ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[prod]${NC} $*"; }
success() { echo -e "${GREEN}[prod]${NC} $*"; }
warn()    { echo -e "${YELLOW}[prod]${NC} $*"; }
error()   { echo -e "${RED}[prod]${NC} $*" >&2; }

# ---------- флаги ----------
BUILD_ONLY=false
SKIP_BUILD=false

for arg in "$@"; do
  case $arg in
    --build-only)  BUILD_ONLY=true  ;;
    --skip-build)  SKIP_BUILD=true  ;;
    --help|-h)
      echo "Использование: $0 [--build-only] [--skip-build]"
      echo "  --build-only  только сборка, без запуска"
      echo "  --skip-build  запуск без пересборки"
      exit 0
      ;;
  esac
done

# ---------- проверки ----------
command -v node  >/dev/null 2>&1 || { error "node не найден"; exit 1; }
command -v pnpm  >/dev/null 2>&1 || { error "pnpm не найден"; exit 1; }

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  error "Требуется Node.js >= 20 (текущий: $(node -v))"; exit 1
fi

# ---------- .env ----------
ENV_FILE="$REPO_ROOT/apps/backend/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  error ".env не найден. Скопируй .env.example → apps/backend/.env и заполни переменные."
  exit 1
fi

# Проверяем обязательные переменные
source "$ENV_FILE" 2>/dev/null || true
: "${B24_APP_ID:?Не задан B24_APP_ID в $ENV_FILE}"
: "${B24_APP_SECRET:?Не задан B24_APP_SECRET в $ENV_FILE}"

# ---------- зависимости ----------
info "Устанавливаю prod-зависимости..."
pnpm install --frozen-lockfile

# ---------- сборка ----------
if [[ "$SKIP_BUILD" == false ]]; then
  info "Собираю @b24-doc-gen/shared..."
  pnpm --filter @b24-doc-gen/shared build

  info "Собираю backend (TypeScript → dist/)..."
  pnpm --filter backend build

  info "Собираю frontend (Vite → dist/)..."
  pnpm --filter frontend build

  success "Сборка завершена"
  echo ""
  echo -e "  Backend:   ${CYAN}apps/backend/dist/${NC}"
  echo -e "  Frontend:  ${CYAN}apps/frontend/dist/${NC}"
  echo ""
fi

[[ "$BUILD_ONLY" == true ]] && { success "Режим --build-only. Запуск пропущен."; exit 0; }

# ---------- миграции ----------
info "Применяю prod-миграции Prisma..."
BACKEND_DIR="$REPO_ROOT/apps/backend"
MIGRATIONS_DIR="$BACKEND_DIR/prisma/migrations"

# Пытаемся применить миграции. Если БД создана через `db push`
# (без _prisma_migrations), `migrate deploy` упадёт с P3005.
# В этом случае одноразово помечаем все существующие миграции как
# применённые (baseline) и повторяем deploy.
if ! NODE_ENV=production pnpm --filter backend exec prisma migrate deploy; then
  warn "migrate deploy не прошёл — пробую baseline существующей БД..."
  if [[ -d "$MIGRATIONS_DIR" ]]; then
    for mig in "$MIGRATIONS_DIR"/*/; do
      name="$(basename "$mig")"
      [[ "$name" == "migration_lock.toml" ]] && continue
      info "  baseline: $name"
      NODE_ENV=production pnpm --filter backend exec prisma migrate resolve --applied "$name" || true
    done
    info "Повторный migrate deploy..."
    NODE_ENV=production pnpm --filter backend exec prisma migrate deploy
  else
    error "Папка миграций не найдена: $MIGRATIONS_DIR"
    exit 1
  fi
fi
NODE_ENV=production pnpm --filter backend exec prisma generate || true

# ---------- запуск ----------
BACKEND_PORT="${BACKEND_PORT:-3001}"
FRONTEND_PORT="${FRONTEND_PORT:-4173}"

success "Запускаю prod-серверы..."
echo ""
echo -e "  ${GREEN}Backend${NC}   http://localhost:${BACKEND_PORT}  (node dist/server.js)"
echo -e "  ${GREEN}Frontend${NC}  http://localhost:${FRONTEND_PORT}  (vite preview)"
echo ""
echo -e "  ${YELLOW}Совет:${NC} в проде лучше раздавать frontend/dist/ через nginx"
echo -e "  Нажми ${YELLOW}Ctrl+C${NC} для остановки"
echo ""

cleanup() {
  trap - SIGINT SIGTERM EXIT
  info "Останавливаю..."
  [[ -n "${BACKEND_PID:-}" ]]  && kill "$BACKEND_PID"  2>/dev/null || true
  [[ -n "${FRONTEND_PID:-}" ]] && kill "$FRONTEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  stty sane 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

export NODE_ENV=production

# Backend
(cd "$REPO_ROOT/apps/backend" && node dist/server.js) &
BACKEND_PID=$!

# Frontend — vite preview (или nginx для настоящего прода)
(cd "$REPO_ROOT/apps/frontend" && pnpm preview --port "$FRONTEND_PORT" --host) &
FRONTEND_PID=$!

wait $BACKEND_PID $FRONTEND_PID
