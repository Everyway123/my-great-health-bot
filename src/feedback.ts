// 👍/👎 under every coach message. Writes to the SAME hermes.feedback table the
// Hermes feedback loop reads (item_type 'health'), so the weekly world-class
// review still sees ground-truth ratings for this surface. Fail-soft: a lost
// vote is not worth an error to the user.

import { InlineKeyboard } from 'grammy';
import { getPool } from './store.js';
import { log } from './logger.js';

let ensured = false;

async function ensureTable(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  if (ensured) return true;
  try {
    await p.query(`
      create table if not exists hermes.feedback (
        id         serial primary key,
        user_id    bigint      not null,
        item_type  text        not null,
        verdict    text        not null,
        created_at timestamptz not null default now()
      )`);
    await p.query('alter table hermes.feedback add column if not exists content text');
    ensured = true;
    return true;
  } catch (err) {
    log({ level: 'error', action: 'feedback_ensure_error', details: { error: String(err).slice(0, 200) } });
    return false;
  }
}

export function feedbackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('👍', 'fb:health:up').text('👎', 'fb:health:dn');
}

export async function recordFeedback(userId: number, verdict: 'up' | 'down', content?: string): Promise<void> {
  if (!(await ensureTable())) return;
  const p = getPool();
  if (!p) return;
  try {
    await p.query('insert into hermes.feedback (user_id, item_type, verdict, content) values ($1, $2, $3, $4)', [
      userId,
      'health',
      verdict,
      content ? content.slice(0, 800) : null,
    ]);
  } catch (err) {
    log({ level: 'warn', action: 'feedback_record_error', details: { error: String(err).slice(0, 120) } });
  }
}
