#!/usr/bin/env bash
# One-command Railway deploy for «Пульс тіла».
#
# Run from a local clone (the agent session's egress policy blocks Railway's
# API, so this has to run on your machine):
#
#   git clone https://github.com/Everyway123/my-great-health-bot
#   cd my-great-health-bot
#   ./scripts/deploy.sh
#
# What it does: links this repo to a Railway project, creates/selects the
# service, sets the 5 env vars, deploys, then tails the logs.
#
# The ONLY secret you type is the new bot token. The other three values are set
# as Railway variable REFERENCES to the existing Hermes service in the same
# project — so nothing has to be copy-pasted or hunted down. That is also why
# the service must live in the SAME project as Hermes (jubilant-hope).

set -euo pipefail

SERVICE="${SERVICE:-pulse-health}"          # name for the new Railway service
HERMES_SERVICE="${HERMES_SERVICE:-hermes-worker}"  # service to borrow vars from
TZ_VALUE="${TZ_VALUE:-Europe/Lisbon}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

command -v railway >/dev/null 2>&1 || die "Railway CLI не встановлений. Постав: npm i -g @railway/cli  (або brew install railway)"

say "1/5 · Перевіряю логін"
if ! railway whoami >/dev/null 2>&1; then
  echo "Не залогінений — відкриваю браузер…"
  railway login
fi
railway whoami

say "2/5 · Лінкую проєкт"
# Якщо ще не злінковано — інтерактивний вибір. ОБЕРИ проєкт, де живе Hermes
# (jubilant-hope), інакше посилання на його змінні не спрацюють.
if ! railway status >/dev/null 2>&1; then
  railway link
fi
railway status || true

say "3/5 · Створюю/обираю сервіс «$SERVICE»"
# `add` падає, якщо сервіс вже існує — це нормально, тоді просто підчіпляємось.
railway add --service "$SERVICE" 2>/dev/null || echo "(сервіс уже існує — продовжую)"
railway service "$SERVICE" 2>/dev/null || true

say "4/5 · Env-змінні"
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  printf 'Встав токен бота від BotFather (@HealthyJoyBot): '
  read -r TELEGRAM_BOT_TOKEN
fi
[ -n "$TELEGRAM_BOT_TOKEN" ] || die "Порожній токен"
# Sanity-check формату: 8-10 цифр, двокрапка, ~35 символів. Ловить обрізану вставку.
if ! printf '%s' "$TELEGRAM_BOT_TOKEN" | grep -qE '^[0-9]{8,12}:[A-Za-z0-9_-]{30,}$'; then
  die "Токен виглядає обрізаним/битим: '${TELEGRAM_BOT_TOKEN:0:12}…' (очікую 123456789:AA…, ~46 символів)"
fi

# ВАЖЛИВО: одинарні лапки — щоб bash НЕ чіпав ${{...}}; Railway має отримати
# їх дослівно і сам підставити значення сусіднього сервісу.
set_var() {
  railway variables --set "$1" >/dev/null 2>&1 || railway variables set "$1" >/dev/null 2>&1 || {
    echo "  ⚠️  не вдалось поставити: ${1%%=*} — постав руками в UI"
    return 0
  }
  echo "  ✓ ${1%%=*}"
}
set_var "TELEGRAM_BOT_TOKEN=$TELEGRAM_BOT_TOKEN"
set_var 'ALLOWED_USER_IDS=${{'"$HERMES_SERVICE"'.ALLOWED_USER_IDS}}'
set_var 'ANTHROPIC_API_KEY=${{'"$HERMES_SERVICE"'.ANTHROPIC_API_KEY}}'
set_var 'DATABASE_URL=${{'"$HERMES_SERVICE"'.DATABASE_URL}}'
set_var "TIMEZONE=$TZ_VALUE"

say "5/5 · Деплой"
railway up --detach

cat <<'EOF'

──────────────────────────────────────────────
Деплой запущено. Далі:
  • Бот САМ напише «🫀 Пульс тіла онлайн», коли підніметься.
  • Логи наживо:   railway logs
  • Змінні:        railway variables

Якщо тиша:
  • «Missing required environment variable» → змінна не підхопилась
    (перевір ім'я Hermes-сервісу: SERVICE=… HERMES_SERVICE=… ./scripts/deploy.sh)
  • «bot_poll_fatal_auth» → токен битий, перевстанови
  • ⛔️-відповідь із твоїм ID → встав цей ID в ALLOWED_USER_IDS
──────────────────────────────────────────────
EOF
