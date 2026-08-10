// 👍/👎 under every coach message. Writes to the SAME hermes.feedback table the
// Hermes feedback loop reads (item_type 'health'), so the weekly world-class
// review still sees ground-truth ratings for this surface. Fail-soft: a lost
// vote is not worth an error to the user.

import { InlineKeyboard } from 'grammy';
import { getPool } from './store.js';
import { log } from './logger.js';

export function feedbackKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('👍', 'fb:health:up').text('👎', 'fb:health:dn');
}

export async function recordFeedback(userId: number, verdict: 'up' | 'down', content?: string): Promise<void> {
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
