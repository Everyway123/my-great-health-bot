// Migration runner. Applies every unapplied migration in order inside its own
// transaction, records it, and never runs it again. Called once at boot before
// anything touches the schema.

import { getPool } from '../store.js';
import { log } from './../logger.js';
import { MIGRATIONS } from './migrations.js';

let done = false;

/** Idempotent. Returns false when the DB is unreachable — callers degrade. */
export async function runMigrations(): Promise<boolean> {
  if (done) return true;
  const pool = getPool();
  if (!pool) return false;

  try {
    await pool.query('create schema if not exists hermes');
    await pool.query(`
      create table if not exists hermes.health_migration (
        id         text primary key,
        applied_at timestamptz not null default now()
      )`);

    const applied = new Set(
      (await pool.query<{ id: string }>('select id from hermes.health_migration')).rows.map((r) => r.id),
    );

    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue;
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(m.sql);
        await client.query('insert into hermes.health_migration (id) values ($1)', [m.id]);
        await client.query('commit');
        log({ level: 'info', action: 'migration_applied', details: { id: m.id } });
      } catch (err) {
        await client.query('rollback').catch(() => {});
        throw new Error(`migration ${m.id} failed: ${String(err).slice(0, 300)}`);
      } finally {
        client.release();
      }
    }
    done = true;
    return true;
  } catch (err) {
    log({ level: 'error', action: 'migration_error', details: { error: String(err).slice(0, 400) } });
    return false;
  }
}
