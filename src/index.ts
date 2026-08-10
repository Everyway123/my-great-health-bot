// Entry point — ONE process: bot polling + crons. A single-purpose bot for a
// single user doesn't need Hermes's bot⟂worker split; it inherits the parts of
// that hardening that cost nothing: global crash handlers, error→Telegram alert
// sink, 409-retrying poll start.
//
// Oura is pulled, not pushed, which is why this still needs no inbound port.

import 'dotenv/config';
import cron from 'node-cron';
import { loadConfig } from './config.js';
import { log, setAlertSink } from './logger.js';
import { createBot } from './bot.js';
import { splitMessage } from './split.js';
import { feedbackKeyboard } from './feedback.js';
import { runHealthDaily, runHealthReport, runMorningCheckin, runTriggerCheck } from './coach.js';
import { runMigrations } from './db/migrate.js';
import { ouraConfig, getStoredToken, syncRange, setLastSyncDay } from './adapters/oura.js';
import { todayInTz, shiftDay } from './day.js';

async function main() {
  const config = loadConfig();
  const bot = createBot(config);
  log({ level: 'info', action: 'config_loaded' });

  // Schema first: everything below assumes the tables exist.
  const migrated = await runMigrations();
  log({ level: migrated ? 'info' : 'warn', action: 'migrations', details: { ok: migrated } });

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
      bot.api
        .sendMessage(userId, `🚨 Пульс тіла — error\n<b>${entry.action}</b>\n${detail}`, { parse_mode: 'HTML' })
        .catch(() => {});
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

  const forEachUser = (action: string, fn: (userId: number) => Promise<void>) => async () => {
    log({ level: 'info', action });
    for (const userId of config.allowedUserIds) {
      try {
        await fn(userId);
      } catch (err) {
        log({ level: 'error', action: `${action}_error`, userId, details: { error: String(err).slice(0, 200) } });
      }
    }
  };

  const tz = { timezone: config.timezone };

  // Oura pull, three times a day. Sleep only reaches Oura's cloud when the app
  // syncs, so a single fixed time would miss late syncs; a 10-day window makes
  // every run self-healing regardless of which one succeeded last.
  cron.schedule(
    '20 6,13,22 * * *',
    forEachUser('cron_oura_sync', async (userId) => {
      const cfg = ouraConfig();
      if (!cfg || !(await getStoredToken(userId))) return;
      const today = todayInTz(config.timezone);
      const r = await syncRange(cfg, userId, shiftDay(today, -10), today);
      await setLastSyncDay(userId, today);
      if (r.errors.length > 0) {
        log({ level: 'warn', action: 'oura_sync_partial', userId, details: { errors: r.errors.slice(0, 3) } });
      }
    }),
    tz,
  );

  // Morning check-in 07:45 — the day's focus BEFORE the day (the digest judges
  // after). Runs after the 06:20 sync so last night is already in.
  cron.schedule('45 7 * * *', forEachUser('cron_morning', async (u) => sendToUser(u, await runMorningCheckin(config, u))), tz);

  // Event-driven check at 14:00 — silent unless the data actually says
  // something. This is the one message that is not on a schedule in spirit:
  // the schedule only decides when we LOOK.
  cron.schedule('0 14 * * *', forEachUser('cron_triggers', async (u) => sendToUser(u, await runTriggerCheck(config, u))), tz);

  // Daily digest 20:45 — digest of today / one-line nudge / silence.
  cron.schedule('45 20 * * *', forEachUser('cron_daily', async (u) => sendToUser(u, await runHealthDaily(config, u))), tz);

  // Weekly trends — Sunday 17:00. Silent when the week has no data.
  cron.schedule(
    '0 17 * * 0',
    forEachUser('cron_weekly', async (u) => sendToUser(u, await runHealthReport(config, u, { days: 7 }))),
    tz,
  );

  // Monthly long view — 1st at 11:00. Longevity is measured in years; a coach
  // that only ever looks back 7 days can't see a pattern that repeats quarterly.
  cron.schedule(
    '0 11 1 * *',
    forEachUser('cron_monthly', async (u) => sendToUser(u, await runHealthReport(config, u, { days: 90 }))),
    tz,
  );

  log({
    level: 'info',
    action: 'crons_scheduled',
    details: { oura: '20 6,13,22', morning: '45 7', triggers: '0 14', daily: '45 20', weekly: 'sun 17:00', monthly: '1st 11:00' },
  });

  // Resilient long-poll start — retries the transient getUpdates-409 during a
  // redeploy; crashes loud on permanent auth failure (revoked token) so Railway
  // restarts/surfaces it instead of leaving a zombie alive on timers.
  for (let attempt = 1; ; attempt++) {
    try {
      await bot.start({
        onStart: () => {
          log({ level: 'info', action: 'bot_started', details: { attempt } });
          console.log('🫀 Пульс тіла is running!');
          for (const userId of config.allowedUserIds) {
            bot.api.sendMessage(userId, '🫀 Пульс тіла онлайн. Кидай фото їжі або пиши /help.').catch(() => {});
          }
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
