// Telegram surface: commands, photo/document handlers, free text, 👍/👎 taps.
// Everything health — this bot does ONE thing. Work/calendar/CRM live in Hermes.

import { Bot, Context } from 'grammy';
import { AppConfig } from './config.js';
import { log } from './logger.js';
import { authMiddleware } from './security.js';
import { splitMessage } from './split.js';
import { feedbackKeyboard, recordFeedback } from './feedback.js';
import { analyzeHealthMedia, handleText, runHealthReport } from './coach.js';
import { getTargets, serializeTargets, TARGET_SPECS } from './targets.js';
import {
  ouraAuth,
  ouraConfig,
  authorizeUrl,
  linkAccount,
  unlinkAccount,
  isConnected,
  syncRange,
  backfill,
  setLastSyncDay,
} from './adapters/oura.js';
import { todayInTz, shiftDay, lastNDays, startOfDayUtcISO, offsetHours } from './day.js';
import { fetchDailyMetrics, serializeMetrics } from './domain/metrics.js';
import { computeRegularity, serializeRegularity, SleepSession } from './domain/sleep.js';
import { fetchHealthSince } from './store.js';
import { fetchExerciseSets } from './domain/strength-store.js';
import { computePRs, hardSetCount, serializeStrength } from './domain/strength.js';

/** First day Andrii owned a ring — the backfill floor. */
const OURA_HISTORY_START = '2022-05-01';

const HELP_TEXT = `
💪 <b>Пульс тіла</b> — твій персональний коуч: харчування, тренування, сон, довголіття.

<b>Як користуватись:</b>
📸 Кинь <b>фото їжі</b> — розпізнаю, оціню ≈калорії/макроси, скажу вердикт і залогую
🧪 Кинь <b>бланк аналізів</b> (фото або PDF) — розберу маркери, покажу динаміку за роки
🏋️ Напиши тренування з підходами — «присід 4×8×80, RPE 8» — і я вестиму прогресію
⌚ Скриншот трекера — витягну числа

<b>Текстом:</b> «вага 91.2», «спав 6 год», «жим 3×10×60» — або питай: «як мій сон за місяць?»

<b>Я запамʼятовую:</b> «запам'ятай: зріст 183, коліно травмоване» — назавжди в профілі. Числові цілі веду окремо: /targets

<b>Команди:</b>
/coach — звіт за 7 дн (/coach 30 — за місяць, до 365)
/sleep — регулярність сну і відновлення
/prs — силові рекорди і що ставити далі
/targets — мої цілі
/profile — що я про тебе знаю
/oura — статус підключення Oura
/sync — синхронізувати Oura зараз
/backfill — затягнути всю історію Oura з ${OURA_HISTORY_START}
/help — це повідомлення

<b>Сам напишу:</b> 07:45 — фокус дня; 20:45 — дайджест; неділя 17:00 — тижневий звіт + план. І поза розкладом, якщо дані скажуть щось важливе (HRV впав, два дні тиші).
`.trim();

async function replyChunked(ctx: Context, msg: string, withFeedback = true): Promise<void> {
  const chunks = splitMessage(msg);
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1;
    const opts = { parse_mode: 'HTML' as const, ...(last && withFeedback ? { reply_markup: feedbackKeyboard() } : {}) };
    await ctx.reply(chunks[i], opts).catch(() => ctx.reply(chunks[i]));
  }
}

export function createBot(config: AppConfig): Bot {
  const bot = new Bot(config.botToken);
  bot.use(authMiddleware(config.allowedUserIds));

  bot.command('start', (ctx) => ctx.reply(`Привіт! Я твій health-бот 🫀\n\n${HELP_TEXT}`, { parse_mode: 'HTML' }));
  bot.command('help', (ctx) => ctx.reply(HELP_TEXT, { parse_mode: 'HTML' }));

  bot.command('coach', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      await ctx.reply('💪 Рахую пульс тіла...');
      const arg = parseInt((ctx.match as string) || '', 10);
      const days = Number.isFinite(arg) && arg >= 1 && arg <= 365 ? arg : 7;
      const msg = await runHealthReport(config, userId, { days });
      if (!msg) {
        await ctx.reply(`💪 Журнал за ${days} дн порожній. Почни просто: кинь фото того, що їси, або підключи каблучку — /oura.`);
        return;
      }
      await replyChunked(ctx, msg);
    } catch (err) {
      log({ level: 'error', action: 'command_coach', details: { error: String(err) } });
      await ctx.reply('⚠️ Не вдалося зібрати звіт. Спробуй пізніше.');
    }
  });

  bot.command('profile', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const { getProfile } = await import('./profile.js');
    const data = await getProfile(userId);
    const keys = Object.keys(data);
    if (keys.length === 0) {
      await ctx.reply('🧠 Профіль поки порожній. Напиши «запам\'ятай: зріст 183, коліно травмоване» — і я почну вести тебе предметно.');
      return;
    }
    const lines = keys.sort().map((k) => `• <b>${k}</b>: ${JSON.stringify(data[k])}`);
    await ctx
      .reply(`🧠 <b>Що я про тебе знаю:</b>\n${lines.join('\n')}\n\n<i>Змінити: «запам'ятай …»; видалити: «забудь …»</i>`, { parse_mode: 'HTML' })
      .catch(() => ctx.reply(`Профіль: ${keys.join(', ')}`));
  });

  bot.command('targets', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const targets = await getTargets(userId);
    const known = TARGET_SPECS.map((s) => `• ${s.label} (${s.unit})`).join('\n');
    await ctx.reply(
      `🎯 <b>Твої цілі</b>\n${serializeTargets(targets)}\n\n<i>Задати: просто скажи — «ціль: 150 г білка, сон 7.5, 3 силових на тиждень». Я валідую і збережу.</i>\n\n<b>Що я вмію рахувати:</b>\n${known}`,
      { parse_mode: 'HTML' },
    ).catch(() => ctx.reply('Цілі показати не вдалося.'));
  });

  // --- Oura ---------------------------------------------------------------

  bot.command('oura', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const auth = ouraAuth();
    if (auth?.kind === 'pat') {
      await ctx.reply(
        '⌚ <b>Oura підключена через персональний токен</b> — нічого авторизувати не треба.\n\n<code>/sync</code> — синхронізувати зараз\n<code>/backfill</code> — затягнути всю історію',
        { parse_mode: 'HTML' },
      );
      return;
    }
    const cfg = ouraConfig();
    if (!cfg) {
      await ctx.reply(
        '⚠️ Oura не налаштована. Найпростіше — персональний токен: створи його на cloud.ouraring.com/personal-access-tokens і поклади в Railway як <code>OURA_TOKEN</code>.\n\nЯкщо токени в акаунті недоступні — тоді OAuth2: <code>OURA_CLIENT_ID</code>, <code>OURA_CLIENT_SECRET</code>, <code>OURA_REDIRECT_URI</code>.',
        { parse_mode: 'HTML' },
      );
      return;
    }
    const existing = await isConnected({ kind: 'oauth', cfg }, userId);
    const url = authorizeUrl(cfg, String(userId));
    await ctx.reply(
      `${existing ? '✅ Каблучка вже підключена. Перепідключити:\n\n' : '⌚ <b>Підключення Oura</b>\n\n'}1. Відкрий посилання і дозволь доступ:\n${url}\n\n2. Тебе перекине на твій redirect URI. Скопіюй з адресного рядка значення <code>code=</code>.\n\n3. Надішли сюди: <code>/oura_code ВСТАВ_КОД</code>\n\n<i>Код живе 10 хвилин.</i>`,
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    );
  });

  bot.command('oura_code', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const cfg = ouraConfig();
    if (!cfg) return void ctx.reply('⚠️ Oura не налаштована (див. /oura).');
    const code = ((ctx.match as string) || '').trim();
    if (!code) return void ctx.reply('Надішли так: <code>/oura_code ВСТАВ_КОД</code>', { parse_mode: 'HTML' });
    try {
      await linkAccount(cfg, userId, code);
      await ctx.reply('✅ Каблучку підключено. Тягну останні 14 днів...');
      const today = todayInTz(config.timezone);
      const r = await syncRange({ kind: 'oauth', cfg }, userId, shiftDay(today, -14), today);
      await setLastSyncDay(userId, today);
      await ctx.reply(
        `⌚ Готово: ${r.days} дн, ${r.events} записів, ${r.metrics} метрик.${r.errors.length ? `\n⚠️ ${r.errors.slice(0, 2).join('; ')}` : ''}\n\nТепер — <code>/backfill</code>, щоб затягнути всю історію з ${OURA_HISTORY_START}.`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      log({ level: 'error', action: 'oura_link_error', details: { error: String(err).slice(0, 200) } });
      await ctx.reply(`⚠️ Не вдалося: ${String(err).slice(0, 200)}\n\nНайчастіше — код прострочений (10 хв) або redirect_uri не збігається з зареєстрованим.`);
    }
  });

  bot.command('oura_unlink', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await unlinkAccount(userId);
    await ctx.reply('⌚ Токени Oura видалено. Дані в журналі лишились.');
  });

  bot.command('sync', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const auth = ouraAuth();
    if (!auth) return void ctx.reply('⚠️ Oura не налаштована (див. /oura).');
    if (!(await isConnected(auth, userId))) return void ctx.reply('⌚ Каблучка не підключена — /oura.');
    await ctx.reply('⌚ Синхронізую...');
    const today = todayInTz(config.timezone);
    const r = await syncRange(auth, userId, shiftDay(today, -7), today);
    await setLastSyncDay(userId, today);
    await ctx.reply(
      `⌚ ${r.days} дн · ${r.events} нових записів · ${r.metrics} метрик${r.errors.length ? `\n⚠️ ${r.errors.slice(0, 2).join('; ')}` : ''}`,
    );
  });

  bot.command('backfill', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const auth = ouraAuth();
    if (!auth) return void ctx.reply('⚠️ Oura не налаштована (див. /oura).');
    if (!(await isConnected(auth, userId))) return void ctx.reply('⌚ Каблучка не підключена — /oura.');
    const arg = ((ctx.match as string) || '').trim();
    const start = /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : OURA_HISTORY_START;
    const today = todayInTz(config.timezone);
    await ctx.reply(`⌚ Тягну історію з ${start}. Це кілька хвилин — писатиму по ходу.`);
    try {
      let lastReport = Date.now();
      const total = await backfill(auth, userId, start, today, (chunk) => {
        // Progress every ~30s: enough to show it's alive, not enough to spam.
        if (Date.now() - lastReport > 30_000) {
          lastReport = Date.now();
          void ctx.reply(`… ${chunk.end}`);
        }
      });
      await setLastSyncDay(userId, today);
      await ctx.reply(
        `✅ Історія затягнута: ${total.days} днів · ${total.events} записів · ${total.metrics} метрик.${total.errors.length ? `\n⚠️ Часткові помилки: ${total.errors.length}` : ''}\n\nТепер спробуй /sleep — там уже є за що зачепитись.`,
      );
    } catch (err) {
      await ctx.reply(`⚠️ Бекфіл впав: ${String(err).slice(0, 200)}`);
    }
  });

  // --- Read-only views ----------------------------------------------------

  bot.command('sleep', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const arg = parseInt((ctx.match as string) || '', 10);
    const days = Number.isFinite(arg) && arg >= 7 && arg <= 365 ? arg : 30;
    const window = lastNDays(config.timezone, days);
    const [metrics, rows] = await Promise.all([
      fetchDailyMetrics(userId, window[0]),
      fetchHealthSince(userId, new Date(Date.now() - days * 86_400_000).toISOString(), ['sleep']),
    ]);
    const sessions: SleepSession[] = rows
      .map((r) => {
        const d = r.data as Record<string, unknown>;
        return { start: Date.parse(String(d.bedtime_start ?? '')), end: Date.parse(String(d.bedtime_end ?? '')) };
      })
      .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start);

    const reg = computeRegularity(
      sessions,
      Date.parse(startOfDayUtcISO(config.timezone, window[0])),
      days,
      offsetHours(config.timezone, window[0]) * 60,
    );
    const body = [serializeRegularity(reg, null), serializeMetrics(metrics, days)].filter(Boolean).join('\n\n');
    await ctx.reply(
      body ? `😴 <b>Сон і відновлення · ${days} дн</b>\n<pre>${body}</pre>` : '😴 Даних про сон ще немає. Підключи каблучку — /oura.',
      { parse_mode: 'HTML' },
    ).catch(() => ctx.reply(body || 'Немає даних'));
  });

  bot.command('prs', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const sets = await fetchExerciseSets(userId, new Date(Date.now() - 365 * 86_400_000).toISOString());
    if (sets.length === 0) {
      await ctx.reply(
        '🏋️ Підходів ще немає. Напиши тренування з вагами — «присід 4×8×80, RPE 8» — і я почну вести прогресію та рекорди.',
      );
      return;
    }
    const body = serializeStrength(computePRs(sets), hardSetCount(sets), 365);
    await ctx.reply(`🏋️ <b>Силові</b>\n<pre>${body}</pre>`, { parse_mode: 'HTML' }).catch(() => ctx.reply(body));
  });

  // --- Media --------------------------------------------------------------

  // Telegram Bot API caps getFile at 20MB — fine for photos and lab PDFs.
  const downloadTelegramFile = async (fileId: string): Promise<string | null> => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  };

  // Shared body for photo + image/PDF document → vision. Keeps "typing…" alive:
  // vision + journal context can run ~30s, a single chat action lasts ~5s.
  const handleMedia = async (ctx: Context, fileId: string, mediaType: string, caption: string) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      await ctx.replyWithChatAction('typing').catch(() => {});
      const typing = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4500);
      let reply: string | null = null;
      try {
        const base64 = await downloadTelegramFile(fileId);
        if (!base64) {
          await ctx.reply('⚠️ Не зміг завантажити файл з Telegram. Спробуй ще раз.');
          return;
        }
        reply = await analyzeHealthMedia(config, userId, { base64, mediaType }, caption);
      } finally {
        clearInterval(typing);
      }
      if (!reply) {
        await ctx.reply('⚠️ Не вдалося проаналізувати. Спробуй ще раз або підпиши фото, що це.');
        return;
      }
      await replyChunked(ctx, reply);
    } catch (err) {
      log({ level: 'error', action: 'health_media_error', details: { error: String(err).slice(0, 200) } });
      await ctx.reply('⚠️ Помилка аналізу.');
    }
  };

  bot.on('message:photo', async (ctx) => {
    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    log({ level: 'info', action: 'photo_received', userId: ctx.from?.id });
    await handleMedia(ctx, largest.file_id, 'image/jpeg', ctx.message.caption ?? '');
  });

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message.document;
    const mime = doc.mime_type ?? '';
    const supported = mime.startsWith('image/') || mime === 'application/pdf';
    if (!supported) {
      await ctx.reply('📄 Такий тип файлу я не аналізую. Надішли фото (їжа/аналізи) або PDF з аналізами.');
      return;
    }
    const MAX_BYTES = 15 * 1024 * 1024;
    if ((doc.file_size ?? 0) > MAX_BYTES) {
      await ctx.reply('⚠️ Файл завеликий (ліміт 15MB). Стисни або надішли фото сторінок.');
      return;
    }
    log({ level: 'info', action: 'document_received', userId: ctx.from?.id, details: { mime } });
    await handleMedia(ctx, doc.file_id, mime, ctx.message.caption ?? '');
  });

  // Free text — a fact to log or a question to the coach; coach.ts decides.
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return;
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      await ctx.replyWithChatAction('typing').catch(() => {});
      const typing = setInterval(() => {
        ctx.replyWithChatAction('typing').catch(() => {});
      }, 4500);
      let reply: string;
      try {
        reply = await handleText(config, userId, text);
      } finally {
        clearInterval(typing);
      }
      await replyChunked(ctx, reply, false);
    } catch (err) {
      log({ level: 'error', action: 'text_error', details: { error: String(err).slice(0, 200) } });
      await ctx.reply('⚠️ Не вдалося обробити повідомлення.');
    }
  });

  // 👍/👎 taps — record + clear the keyboard so the same message can't be
  // double-voted. Feeds the shared hermes.feedback table.
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    const userId = ctx.from?.id;
    if (!userId || !data.startsWith('fb:')) {
      await ctx.answerCallbackQuery({ text: 'Невідомий запит' }).catch(() => {});
      return;
    }
    const v = data.split(':')[2];
    const msg = ctx.callbackQuery.message;
    const rated = (msg && 'text' in msg ? msg.text : undefined) ?? (msg && 'caption' in msg ? msg.caption : undefined);
    await recordFeedback(userId, v === 'up' ? 'up' : 'down', rated);
    await ctx.answerCallbackQuery({ text: v === 'up' ? '👍 Дякую — врахую' : '👎 Зрозумів — підкручу' });
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  });

  return bot;
}
