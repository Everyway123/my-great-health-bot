// Telegram surface: commands, photo/document handlers, free text, 👍/👎 taps.
// Everything health — this bot does ONE thing. Work/calendar/CRM live in Hermes.

import { Bot, Context } from 'grammy';
import { AppConfig } from './config.js';
import { log } from './logger.js';
import { authMiddleware } from './security.js';
import { splitMessage } from './split.js';
import { feedbackKeyboard, recordFeedback } from './feedback.js';
import { analyzeHealthMedia, handleText, runHealthReport } from './coach.js';

const HELP_TEXT = `
💪 <b>Пульс тіла</b> — твій персональний коуч: харчування, тренування, сон, довголіття.

<b>Як користуватись:</b>
📸 Кинь <b>фото їжі</b> — розпізнаю, оціню ≈калорії/макроси, скажу вердикт і залогую
🧪 Кинь <b>бланк аналізів</b> (фото або PDF) — розберу маркери, скажу що поза нормою
⌚ Скриншот трекера (сон/ваги/годинник) — витягну числа в журнал

<b>Текстом:</b> просто пиши — «вага 91.2», «спав 6 год», «трен ноги 45 хв» — або питай: «скільки калорій за тиждень?», «що їсти на вечерю?»

<b>Я запамʼятовую:</b> скажи «запам'ятай: зріст 183, ціль 88 кг, коліно травмоване» — і це назавжди в профілі. Історію розмови теж памʼятаю.

<b>Команди:</b>
/coach — звіт за 7 дн (/coach 30 — за місяць)
/profile — що я про тебе знаю
/help — це повідомлення

<b>Сам напишу:</b> 07:45 — фокус дня; 20:45 — дайджест дня; неділя 17:00 — тижневий звіт + план на тиждень (відповіси «прийнято» — зафіксую і вестиму по ньому).
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
      const arg = parseInt((ctx.match as string || '').trim(), 10);
      const days = Number.isFinite(arg) && arg >= 1 && arg <= 90 ? arg : 7;
      const msg = await runHealthReport(config, userId, { days });
      if (!msg) {
        await ctx.reply(`💪 Журнал за ${days} дн порожній. Почни просто: кинь фото того, що їси, або напиши «вага 91.2».`);
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
      await ctx.reply('🧠 Профіль поки порожній. Напиши «запам\'ятай: зріст 183, ціль 88 кг» — і я почну вести тебе предметно.');
      return;
    }
    const lines = keys.sort().map((k) => `• <b>${k}</b>: ${JSON.stringify(data[k])}`);
    await ctx.reply(`🧠 <b>Що я про тебе знаю:</b>\n${lines.join('\n')}\n\n<i>Змінити: «запам'ятай …»; видалити: «забудь …»</i>`, { parse_mode: 'HTML' })
      .catch(() => ctx.reply(`Профіль: ${keys.join(', ')}`));
  });

  // Telegram Bot API caps getFile at 20MB — fine for photos and lab PDFs.
  const downloadTelegramFile = async (fileId: string): Promise<string | null> => {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) return null;
    const res = await fetch(`https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  };

  // Shared body for photo + image/PDF document → vision. Keeps "typing…" alive:
  // vision + journal context can run ~20s, a single chat action lasts ~5s.
  const handleMedia = async (ctx: Context, fileId: string, mediaType: string, caption: string) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      await ctx.replyWithChatAction('typing').catch(() => {});
      const typing = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4500);
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
      const typing = setInterval(() => { ctx.replyWithChatAction('typing').catch(() => {}); }, 4500);
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
  // double-voted. Feeds the shared hermes.feedback table Hermes's weekly
  // self-review reads.
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
