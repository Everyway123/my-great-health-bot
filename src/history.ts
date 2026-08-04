// Conversation memory for the coach chat — a mentor who forgets the previous
// message isn't a mentor. Durable in pg (survives redeploys), hydrated per
// turn; only TEXT ever lands here so history is always trim-safe.

import { getPool } from './store.js';
import { log } from './logger.js';

let ensured = false;

async function ensureTable(): Promise<boolean> {
  const p = getPool();
  if (!p) return false;
  if (ensured) return true;
  try {
    await p.query(`
      create table if not exists hermes.health_chat (
        id         serial primary key,
        user_id    bigint not null,
        role       text   not null,
        content    text   not null,
        created_at timestamptz not null default now()
      )`);
    ensured = true;
    return true;
  } catch (err) {
    log({ level: 'error', action: 'health_chat_table_error', details: { error: String(err).slice(0, 200) } });
    return false;
  }
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export async function storeTurn(userId: number, role: 'user' | 'assistant', content: string): Promise<void> {
  if (!content || content.trim().length === 0) return;
  if (!(await ensureTable())) return;
  const p = getPool();
  if (!p) return;
  try {
    await p.query('insert into hermes.health_chat (user_id, role, content) values ($1, $2, $3)', [
      userId,
      role,
      content.slice(0, 6000),
    ]);
  } catch (err) {
    log({ level: 'warn', action: 'health_chat_store_error', details: { error: String(err).slice(0, 120) } });
  }
}

/** Last `limit` turns, oldest-first (the shape the messages array wants). */
export async function loadTurns(userId: number, limit = 16): Promise<ChatTurn[]> {
  if (!(await ensureTable())) return [];
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query<{ role: string; content: string }>(
      `select role, content from hermes.health_chat
        where user_id = $1 order by created_at desc, id desc limit $2`,
      [userId, limit],
    );
    return res.rows.reverse().map((r) => ({ role: r.role === 'user' ? 'user' : 'assistant', content: r.content }));
  } catch (err) {
    log({ level: 'warn', action: 'health_chat_load_error', details: { error: String(err).slice(0, 120) } });
    return [];
  }
}
