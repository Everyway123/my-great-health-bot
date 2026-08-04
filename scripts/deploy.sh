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

# Читання полів `railway status`. Схема --json відрізняється між версіями CLI
# (саме тому попередня версія скрипта вирішила, що лінк не вдався, хоча він
# вдався), тож: пробуємо кілька ключів JSON, а далі — текстовий вивід, який
# стабільний уже багато релізів ("Project: x" / "Service: y"). ANSI-кольори
# зрізаємо, бо в деяких терміналах вони лізуть навіть у пайп.
status_field() { # $1 = Project | Service | Environment
  local out v k
  out="$(railway status --json 2>/dev/null || true)"
  if [ -n "$out" ]; then
    case "$1" in
      Project)     for k in projectName project name; do v="$(printf '%s' "$out" | json_get "$k")"; [ -n "$v" ] && break; done ;;
      Service)     for k in serviceName service; do     v="$(printf '%s' "$out" | json_get "$k")"; [ -n "$v" ] && break; done ;;
      Environment) for k in environmentName environment; do v="$(printf '%s' "$out" | json_get "$k")"; [ -n "$v" ] && break; done ;;
    esac
    if [ -n "${v:-}" ]; then printf '%s' "$v"; return 0; fi
  fi
  railway status 2>/dev/null | sed $'s/\033\\[[0-9;]*m//g' | sed -n "s/^$1:[[:space:]]*//p" | head -1 | tr -d '\r'
}
linked_service() { status_field Service; }
linked_project() { status_field Project; }

say "1/6 · Логін"
railway whoami >/dev/null 2>&1 || railway login
railway whoami

# --- 2-3. Знайти проєкт+сервіс Hermes і забрати звідти змінні ---------------
# Цикл, а не одна спроба: у Andrii кілька проєктів (jubilant-hope,
# remarkable-forgiveness, sweet-enchantment…), і з першого разу вгадати, де
# саме Hermes, нереально. Помилився — просто пробуєш ще раз, без рестарту.
RAW=""
ATTEMPT=0
while [ -z "$RAW" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -gt 5 ] && die "5 спроб — здаюсь. Глянь у дашборді точні назви проєкту й сервісу."

  say "2/6 · Обери проєкт, де живе Hermes (там, де Postgres і ключі) — спроба $ATTEMPT"
  echo "У списку обери проєкт, у якому є сервіс '$HERMES_SERVICE'."
  railway link || true
  HERMES_PROJECT="$(linked_project)"
  [ -n "$HERMES_PROJECT" ] && ok "Проєкт: $HERMES_PROJECT" || warn "Не зміг прочитати назву проєкту (не критично, йду далі)"

  say "3/6 · Читаю змінні з сервісу $HERMES_SERVICE"
  RAW="$(railway variables --service "$HERMES_SERVICE" --json 2>/dev/null || true)"

  if [ -z "$RAW" ]; then
    warn "У проєкті '${HERMES_PROJECT:-?}' нема сервісу '$HERMES_SERVICE' (або він порожній)."
    echo  "  Варіанти:"
    echo  "   1) обрати ІНШИЙ проєкт  — Enter"
    echo  "   2) інша назва сервісу   — введи її (напр. hermes, jubilant-hope, worker)"
    echo  "   3) вийти                — q"
    printf '> '
    read -r CHOICE
    case "$CHOICE" in
      q|Q) die "Вихід на прохання користувача" ;;
      "")  : ;;                       # ще раз обрати проєкт
      *)   HERMES_SERVICE="$CHOICE"   # спробувати іншу назву в ТОМУ Ж проєкті
           RAW="$(railway variables --service "$HERMES_SERVICE" --json 2>/dev/null || true)"
           [ -n "$RAW" ] && ok "Знайшов сервіс $HERMES_SERVICE" ;;
    esac
  fi
done
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
if [ -z "$CURRENT" ]; then
  # Не змогли визначити — НЕ вгадуємо. Показуємо факт і питаємо явно, бо ціна
  # помилки — залитий чужий сервіс (bloom-print).
  warn "Не зміг автоматично визначити залінкований сервіс. Ось що каже CLI:"
  railway status || true
  printf "\nЗверху має бути Service: %s. Деплоїмо туди? [y/N]: " "$SERVICE"
  read -r CONFIRM
  case "$CONFIRM" in
    [Yy]*) ok "Підтверджено вручну" ;;
    *) die "Скасовано. Виконай:  railway service $SERVICE   і запусти скрипт знову." ;;
  esac
elif [ "$CURRENT" != "$SERVICE" ]; then
  die "Залінкований сервіс '$CURRENT', а не '$SERVICE'.
  Деплой ЗУПИНЕНО, щоб не перезаписати чужий сервіс.
  Виправ вручну:  railway service $SERVICE   і запусти скрипт знову."
else
  ok "Залінкований сервіс: $CURRENT (збігається — деплой безпечний)"
fi

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
