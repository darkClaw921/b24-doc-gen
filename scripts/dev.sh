#!/usr/bin/env bash
# dev.sh — запуск dev-окружения (backend + frontend с hot-reload)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- цвета ----------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[dev]${NC} $*"; }
success() { echo -e "${GREEN}[dev]${NC} $*"; }
warn()    { echo -e "${YELLOW}[dev]${NC} $*"; }
error()   { echo -e "${RED}[dev]${NC} $*" >&2; }

# ---------- проверки ----------
command -v node  >/dev/null 2>&1 || { error "node не найден"; exit 1; }
command -v pnpm  >/dev/null 2>&1 || { error "pnpm не найден — установи: npm i -g pnpm"; exit 1; }

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  error "Требуется Node.js >= 20 (текущий: $(node -v))"; exit 1
fi

# ---------- .env ----------
ENV_FILE="$REPO_ROOT/apps/backend/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  warn ".env не найден — создаю из .env.example"
  cp "$REPO_ROOT/.env.example" "$ENV_FILE"
  warn "Заполни $ENV_FILE (B24_APP_ID, B24_APP_SECRET) перед работой с Bitrix24"
fi

# ---------- зависимости ----------
if [[ ! -d "$REPO_ROOT/node_modules" ]]; then
  info "Устанавливаю зависимости..."
  pnpm install
fi

# ---------- shared build ----------
info "Собираю @b24-doc-gen/shared..."
pnpm --filter @b24-doc-gen/shared build

# ---------- БД ----------
# Используем `prisma db push` (синхронизация schema → SQLite без миграций).
# Для dev этого достаточно: схема в schema.prisma всегда совпадает с dev.db.
info "Синхронизирую схему БД (prisma db push)..."
(cd "$REPO_ROOT/apps/backend" && pnpm exec prisma db push --skip-generate --accept-data-loss) || \
  warn "Не удалось синхронизировать БД — проверь schema.prisma"

(cd "$REPO_ROOT/apps/backend" && pnpm exec prisma generate) || true

# ---------- запуск ----------
success "Запускаю dev-серверы..."
echo ""
echo -e "  ${GREEN}Backend${NC}   http://localhost:${BACKEND_PORT:-3001}  ← ${YELLOW}ngrok указывай на ЭТОТ порт${NC}"
echo -e "  ${GREEN}Frontend${NC}  http://localhost:${FRONTEND_PORT:-5173}  (Vite, с hot-reload)"
echo ""
echo -e "  Пример:  ${CYAN}ngrok http ${BACKEND_PORT:-3001}${NC}"
echo -e "  Затем укажи ngrok-URL в Bitrix24 как URL приложения"
echo -e "  (бэкенд перенаправит GET / → Vite, API-запросы обработает сам)"
echo ""
echo -e "  Нажми ${YELLOW}Ctrl+C${NC} для остановки"
echo ""

# Trap Ctrl+C — убиваем дочерние процессы
trap 'info "Останавливаю..."; kill 0; exit 0' SIGINT SIGTERM

export NODE_ENV=development

pnpm --filter backend dev &
BACKEND_PID=$!

# небольшая пауза чтобы backend стартовал раньше frontend
sleep 1

pnpm --filter frontend dev &
FRONTEND_PID=$!

wait $BACKEND_PID $FRONTEND_PID
