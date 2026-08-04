// Entry point — ONE process: bot polling + 2 crons. A single-purpose bot for a
// single user doesn't need Hermes's bot⟂worker split; it inherits the parts of
// that hardening that cost nothing: global crash handlers, error→Telegram alert
// sink, 409-retrying poll start.

import 'dotenv/config';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { log, setAlertSink } from './logger.js';
import { createBot } from './bot.js';
import { splitMessage } from './split.js';
import { feedbackKeyboard } from './feedback.js';
import { runHealthDaily, runHealthReport } from './coach.js';

async function main() {
  const config = loadConfig();
  const bot = createBot(config);
  log({ level: 'info', action: 'config_loaded' });

  // Error logs → Telegram (throttled per action). A failing cron/handler
  // surfaces in minutes instead of rotting silently in stdout.
  const lastAlertAt = new Map<string, number>();
  const ALERT_THROTTLE_MS = 10 * 60 * 1000;
  setAlertSink((entry) => {
    const now = Date.now();
    if (now - (lastAlertAt.get(entry.action) ?? 0) < ALERT_THROTTLE_MS) return;
    lastAlertAt.set(entry.action, now);
    const detail = entry.details ? JSON.stringify(entry.details).slice(0, 300) : '';
    for (const userId of config.allowedUserIds) {
      bot.api.sendMessage(userId, `🚨 Пульс тіла — error\n<b>${entry.action}</b>\n${detail}`, { parse_mode: 'HTML' }).catch(() => {});
    }
  });

  // Global crash handlers: an un-.catch()'d await in a cron must not silently
  // kill the process. Rejections log+alert and keep running; exceptions exit
  // for a clean Railway restart.
  process.on('unhandledRejection', (reason) => {
    log({ level: 'error', action: 'unhandled_rejection', details: { reason: String(reason).slice(0, 400) } });
  });
  process.on('uncaughtException', (err) => {
    log({ level: 'error', action: 'uncaught_exception', details: { error: String(err?.stack || err).slice(0, 400) } });
    setTimeout(() => process.exit(1), 2000);
  });

  // Per-user send with 👍/👎 + 4096-chunking. Null msg → silence (a feature).
  const sendToUser = async (userId: number, msg: string | null) => {
    if (!msg) return;
    const chunks = splitMessage(msg);
    for (let i = 0; i < chunks.length; i++) {
      const last = i === chunks.length - 1;
      const opts = { parse_mode: 'HTML' as const, ...(last ? { reply_markup: feedbackKeyboard() } : {}) };
      await bot.api.sendMessage(userId, chunks[i], opts).catch(() => bot.api.sendMessage(userId, chunks[i]));
    }
  };

  // Daily digest 20:45 — digest of today / one-line nudge / silence.
  cron.schedule(
    '45 20 * * *',
    async () => {
      log({ level: 'info', action: 'cron_daily' });
      for (const userId of config.allowedUserIds) {
        try {
          await sendToUser(userId, await runHealthDaily(config, userId));
        } catch (err) {
          log({ level: 'error', action: 'cron_daily_error', userId, details: { error: String(err) } });
        }
      }
    },
    { timezone: config.timezone },
  );

  // Weekly trends — Sunday 17:00. Silent when the week has no data.
  cron.schedule(
    '0 17 * * 0',
    async () => {
      log({ level: 'info', action: 'cron_weekly' });
      for (const userId of config.allowedUserIds) {
        try {
          await sendToUser(userId, await runHealthReport(config, userId, { days: 7 }));
        } catch (err) {
          log({ level: 'error', action: 'cron_weekly_error', userId, details: { error: String(err) } });
        }
      }
    },
    { timezone: config.timezone },
  );
  log({ level: 'info', action: 'crons_scheduled', details: { daily: '45 20 * * *', weekly: '0 17 * * 0' } });

  // Resilient long-poll start — retries the transient getUpdates-409 during a
  // redeploy; crashes loud on permanent auth failure (revoked token) so Railway
  // restarts/surfaces it instead of leaving a zombie alive on timers.
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: () => {
          log({ level: 'info', action: 'bot_started', details: { attempt } });
          console.log('🫀 Пульс тіла is running!');
        },
      });
      return;
    } catch (err) {
      const msg = String((err as Error)?.message ?? err);
      const conflict = msg.includes('409') || /conflict/i.test(msg);
      if (msg.includes('401') || msg.includes('403') || /unauthorized|invalid token|not found/i.test(msg)) {
        log({ level: 'error', action: 'bot_poll_fatal_auth', details: { attempt, error: msg.slice(0, 160) } });
        setTimeout(() => process.exit(1), 2000);
        return;
      }
      log({ level: conflict ? 'warn' : 'error', action: 'bot_poll_restart', details: { attempt, error: msg.slice(0, 160) } });
      await new Promise((r) => setTimeout(r, conflict ? 6000 : 15000));
    }
  }
}

main().catch((err) => {
  log({ level: 'error', action: 'startup_error', details: { error: String(err) } });
  process.exit(1);
});
