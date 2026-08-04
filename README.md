# Пульс тіла 🫀

Персональний health-бот Андрія Сусленка: **нутриціолог + спортивний тренер +
коуч сну/відновлення** в одному Telegram-боті. Виділений з Hermes (life_OS)
2026-08-04, коли health-потік почав плутатися з робочим асистентом.

## Що вміє

- 📸 **Фото їжі** → Claude vision: страва, ≈калорії/макроси, прямий вердикт
  («прибери X, додай Y»), запис у журнал
- 🧪 **Аналізи** — фото бланку або PDF → маркери з референсами, що поза нормою;
  далі коуч звіряє їжу з цими маркерами
- ⌚ **Скриншоти трекерів** (сон/ваги/годинник) → числа в журнал
- ✍️ **Текст без команд** — факт («вага 91.2», «спав 6 год», «ціль: 88 кг»)
  логується; питання («скільки калорій за тиждень?») отримує відповідь з журналу
- `/coach [днів]` — звіт на вимогу (default 7, cap 90)
- **Крони:** щодня 20:45 — дайджест дня (є записи → підсумок; пусто, але звичка
  є → короткий пуш без LLM; журнал пустий → мовчить); неділя 17:00 — тижневі
  тренди (мовчить без даних)
- 👍/👎 під кожною відповіддю — фідбек у спільну `hermes.feedback`

## Архітектура

Один процес: grammy-бот + 2 node-cron. TypeScript ESM, патерни успадковані від
Hermes: Zero Trust (`ALLOWED_USER_IDS`), анти-галюцинаційний блок у кожному
промпті, self-healing таблиці, error→Telegram alert sink, глобальні
crash-хендлери, 409-retry на старті полінгу, `splitMessage` на всіх сендах.

**База — ТА САМА, що в Hermes** (`DATABASE_URL` вказує на спільний Railway pg):
пише в `hermes.health_log` і `hermes.feedback`. Усе, що було залоговано ще
через Hermes, збереглося; Hermes-аналітика (world-class review) далі бачить
health-фідбек.

```
src/
  index.ts    — boot: alert sink, crash handlers, крони, полінг
  bot.ts      — команди + photo/document/text хендлери + fb-callback
  coach.ts    — персона, vision-аналіз, текстовий лог/чат, звіти, дайджест
  store.ts    — hermes.health_log (self-healing) + серіалізація журналу
  feedback.ts — 👍/👎 → hermes.feedback (item_type 'health')
  config.ts, security.ts, logger.ts, models.ts, prompts.ts, day.ts, split.ts
```

## Деплой (Railway)

1. Новий сервіс з цього репо (`main`), Dockerfile підхопиться сам.
2. Env-змінні (див. `.env.example`):
   - `TELEGRAM_BOT_TOKEN` — токен НОВОГО бота з BotFather (ніколи не в код)
   - `ALLOWED_USER_IDS` — Telegram id через кому
   - `ANTHROPIC_API_KEY` — можна той самий, що в Hermes
   - `DATABASE_URL` — connection string спільного pg з проєкту jubilant-hope
   - `TIMEZONE` — `Europe/Lisbon`
3. Після деплою: `/start` боту — і кидай перше фото їжі.

Перевір значення після вставки (`railway variables`) — CLI інколи тихо обрізає
останній символ токена.

## Команди розробки

- `npm run dev` — локально з hot reload
- `npm run build` — компіляція TypeScript
- `npm test` — vitest (чисті функції: парсер JSON-контракту, nudge-логіка,
  серіалізація журналу)
