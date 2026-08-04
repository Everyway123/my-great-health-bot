#!/usr/bin/env bash
# One-command Railway deploy for «Пульс тіла».
#
#   git clone https://github.com/Everyway123/my-great-health-bot
#   cd my-great-health-bot
#   ./scripts/deploy.sh
#
# Що робить: читає потрібні змінні З ІСНУЮЧОГО Hermes-сервісу, створює новий
# сервіс під health-бота, переносить туди значення, деплоїть.
#
# Ти вводиш ЛИШЕ токен бота. ANTHROPIC_API_KEY / DATABASE_URL / ALLOWED_USER_IDS
# копіюються автоматично — їх не треба ні шукати, ні набирати, ні комусь давати.
#
# Компроміси, закладені навмисно:
#  - копіюємо ЗНАЧЕННЯ, а не ${{refs}} — refs працюють лише в межах одного
#    проєкту, а health-бот може жити в іншому;
#  - перед деплоєм ЖОРСТКА перевірка, що залінкований саме наш сервіс —
#    інакше `railway up` перезаписав би чужий сервіс (напр. bloom-print);
#  - bash 3.2-friendly (macOS): без declare -A, mapfile, ${x,,};
#  - жодних лапок-ялинок навколо змінних — у не-UTF8 локалі bash 3.2 приліплює
#    їхні байти до імені змінної (це і був баг "SERVICE?: unbound variable").

set -euo pipefail

SERVICE="${SERVICE:-pulse-health}"                  # новий сервіс для health-бота
HERMES_SERVICE="${HERMES_SERVICE:-hermes-worker}"   # звідки копіювати змінні
TZ_VALUE="${TZ_VALUE:-Europe/Lisbon}"
COPY_VARS="ANTHROPIC_API_KEY DATABASE_URL ALLOWED_USER_IDS"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m*\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mERROR: %s\033[0m\n\n' "$*" >&2; exit 1; }

command -v railway >/dev/null 2>&1 || die "Railway CLI не встановлений: npm i -g @railway/cli"

# --- JSON helper: python3 -> node -> jq (що є на машині) --------------------
json_get() { # $1 = key; JSON на stdin
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get(sys.argv[1],""))' "$1" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(s)[process.argv[1]]??""))}catch(e){}})' "$1" 2>/dev/null
  elif command -v jq >/dev/null 2>&1; then
    jq -r --arg k "$1" '.[$k] // ""' 2>/dev/null
  else
    die "Нема python3/node/jq для розбору JSON"
  fi
}

# Ім'я сервісу, на який CLI зараз залінкований (порожньо, якщо жодного).
linked_service() { railway status --json 2>/dev/null | json_get "serviceName"; }
linked_project() { railway status --json 2>/dev/null | json_get "projectName"; }

say "1/6 · Логін"
railway whoami >/dev/null 2>&1 || railway login
railway whoami

# --- 2. Проєкт з Hermes: звідки беремо змінні -------------------------------
say "2/6 · Обери проєкт, де живе Hermes (там, де Postgres і ключі)"
echo "Зараз відкриється список проєктів. Обери той, у якому є сервіс '$HERMES_SERVICE'."
railway link
HERMES_PROJECT="$(linked_project)"
[ -n "$HERMES_PROJECT" ] || die "Проєкт не залінкувався"
ok "Проєкт: $HERMES_PROJECT"

say "3/6 · Копіюю змінні з сервісу $HERMES_SERVICE"
RAW="$(railway variables --service "$HERMES_SERVICE" --json 2>/dev/null || true)"
if [ -z "$RAW" ]; then
  warn "Сервіс '$HERMES_SERVICE' не знайдений у проєкті $HERMES_PROJECT."
  echo  "  Подивись точну назву в дашборді і перезапусти:"
  echo  "    HERMES_SERVICE=<ім'я> ./scripts/deploy.sh"
  die   "Не можу прочитати змінні"
fi
VAL_ANTHROPIC="$(printf '%s' "$RAW" | json_get ANTHROPIC_API_KEY)"
VAL_DATABASE="$(printf '%s'  "$RAW" | json_get DATABASE_URL)"
VAL_USERIDS="$(printf '%s'   "$RAW" | json_get ALLOWED_USER_IDS)"
for pair in "ANTHROPIC_API_KEY:$VAL_ANTHROPIC" "DATABASE_URL:$VAL_DATABASE" "ALLOWED_USER_IDS:$VAL_USERIDS"; do
  name="${pair%%:*}"; val="${pair#*:}"
  [ -n "$val" ] && ok "$name — прочитано (${#val} символів)" || warn "$name — ПОРОЖНЯ в $HERMES_SERVICE"
done
[ -n "$VAL_DATABASE" ] || die "DATABASE_URL порожній — без бази бот не має сенсу"

# --- 4. Цільовий проєкт + сервіс -------------------------------------------
say "4/6 · Куди ставимо health-бота"
echo "Рекомендація: ТОЙ САМИЙ проєкт ($HERMES_PROJECT) — все поруч."
printf 'Залишити тут? [Y/n]: '
read -r ANSWER
case "$ANSWER" in
  [Nn]*) echo "Обери інший проєкт:"; railway link ;;
esac
TARGET_PROJECT="$(linked_project)"
ok "Цільовий проєкт: $TARGET_PROJECT"

railway add --service "$SERVICE" >/dev/null 2>&1 && ok "Створив сервіс $SERVICE" || warn "Сервіс $SERVICE вже існує — використовую його"
railway service "$SERVICE" >/dev/null 2>&1 || true

# ЗАПОБІЖНИК. Без нього `railway up` заллє код у той сервіс, що залишився
# залінкованим (у Andrii це був bloom-print) і перезапише чужий застосунок.
CURRENT="$(linked_service)"
if [ "$CURRENT" != "$SERVICE" ]; then
  die "Залінкований сервіс '$CURRENT', а не '$SERVICE'.
  Деплой ЗУПИНЕНО, щоб не перезаписати чужий сервіс.
  Виправ вручну:  railway service $SERVICE   і запусти скрипт знову."
fi
ok "Залінкований сервіс: $CURRENT (збігається — деплой безпечний)"

# --- 5. Змінні на новому сервісі -------------------------------------------
say "5/6 · Змінні"
if [ -z "${TELEGRAM_BOT_TOKEN:-}" ]; then
  printf 'Токен бота від BotFather: '
  read -r TELEGRAM_BOT_TOKEN
fi
printf '%s' "$TELEGRAM_BOT_TOKEN" | grep -qE '^[0-9]{8,12}:[A-Za-z0-9_-]{30,}$' \
  || die "Токен виглядає обрізаним/битим (очікую 123456789:AA…, ~46 символів)"

set_var() { # $1=NAME  $2=VALUE
  [ -n "$2" ] || { warn "$1 порожній — пропускаю"; return 0; }
  if railway variables --set "$1=$2" >/dev/null 2>&1 || railway variables set "$1=$2" >/dev/null 2>&1; then
    ok "$1"
  else
    warn "$1 — не вдалось; постав руками в UI"
  fi
}
set_var TELEGRAM_BOT_TOKEN "$TELEGRAM_BOT_TOKEN"
set_var ANTHROPIC_API_KEY  "$VAL_ANTHROPIC"
set_var DATABASE_URL       "$VAL_DATABASE"
set_var ALLOWED_USER_IDS   "$VAL_USERIDS"
set_var TIMEZONE           "$TZ_VALUE"

# --- 6. Деплой --------------------------------------------------------------
say "6/6 · Деплой у $TARGET_PROJECT / $SERVICE"
railway up --detach

cat <<'EOF'

──────────────────────────────────────────────
Деплой пішов. Бот САМ напише «Пульс тіла онлайн», коли підніметься.
  логи:    railway logs
  змінні:  railway variables

Якщо тиша:
  • "Missing required environment variable" -> змінна не доїхала
  • "bot_poll_fatal_auth"                   -> токен битий
  • відповідь із твоїм ID                   -> встав його в ALLOWED_USER_IDS
──────────────────────────────────────────────
EOF
