// Ordered, numbered migrations. Replaces the old `create table if not exists`
// self-healing scattered across modules: once the schema has more than one
// table, "each module heals itself" stops being cheap and starts hiding drift.
//
// Rules:
//   - Append only. Never edit an applied migration — add a new one.
//   - Every statement must be idempotent anyway (if not exists / add column if
//     not exists), so a half-applied migration can be re-run safely.
//   - hermes.health_log is NOT recreated: it already holds Andrii's history
//     from the Hermes era. It is EXTENDED into the canonical event store.

export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_base',
    sql: `
      create schema if not exists hermes;
      create table if not exists hermes.health_log (
        id         serial primary key,
        user_id    bigint      not null,
        kind       text        not null,
        content    text        not null,
        data       jsonb       not null default '{}',
        logged_at  timestamptz not null default now()
      );
      create table if not exists hermes.health_profile (
        user_id    bigint primary key,
        data       jsonb not null default '{}',
        updated_at timestamptz not null default now()
      );
      create table if not exists hermes.health_chat (
        id         serial primary key,
        user_id    bigint not null,
        role       text   not null,
        content    text   not null,
        created_at timestamptz not null default now()
      );
      create table if not exists hermes.feedback (
        id         serial primary key,
        user_id    bigint      not null,
        item_type  text        not null,
        verdict    text        not null,
        created_at timestamptz not null default now()
      );
      alter table hermes.feedback add column if not exists content text;
    `,
  },

  {
    // health_log becomes the canonical immutable event store: every fact gets a
    // source and (where the upstream has a stable id) a dedup key, so a repeated
    // Oura sync physically cannot create a duplicate that would skew averages.
    id: '002_event_store',
    sql: `
      alter table hermes.health_log add column if not exists source text not null default 'telegram';
      alter table hermes.health_log add column if not exists dedup_key text;
      create unique index if not exists health_log_dedup_uniq
        on hermes.health_log (user_id, dedup_key) where dedup_key is not null;
      create index if not exists health_log_user_time
        on hermes.health_log (user_id, logged_at desc);
      create index if not exists health_chat_user_time
        on hermes.health_chat (user_id, created_at desc);
    `,
  },

  {
    // Derived, always recomputable: one row per (day, metric, source). Upsert
    // semantics make re-syncing a day free of side effects.
    id: '003_daily_metric',
    sql: `
      create table if not exists hermes.health_daily_metric (
        user_id    bigint      not null,
        day        date        not null,
        metric     text        not null,
        source     text        not null default 'oura',
        value      double precision not null,
        unit       text        not null default '',
        updated_at timestamptz not null default now(),
        primary key (user_id, day, metric, source)
      );
      create index if not exists health_daily_metric_lookup
        on hermes.health_daily_metric (user_id, metric, day desc);
    `,
  },

  {
    // Lab markers as first-class rows instead of a jsonb array inside an event.
    // A ten-year trend cannot be assembled on the fly from blobs.
    id: '004_lab_marker',
    sql: `
      create table if not exists hermes.health_lab_marker (
        id         serial primary key,
        user_id    bigint      not null,
        drawn_at   timestamptz not null,
        marker_key text        not null,
        name_raw   text        not null,
        value_num  double precision,
        value_text text,
        unit       text        not null default '',
        ref_raw    text        not null default '',
        flag       text        not null default '',
        event_id   bigint,
        created_at timestamptz not null default now()
      );
      create unique index if not exists health_lab_marker_uniq
        on hermes.health_lab_marker (user_id, marker_key, drawn_at);
      create index if not exists health_lab_marker_series
        on hermes.health_lab_marker (user_id, marker_key, drawn_at desc);
    `,
  },

  {
    // Sets are the unit of strength training. Without them "progressive
    // overload" is a word in a prompt, not something the coach can drive.
    id: '005_exercise_set',
    sql: `
      create table if not exists hermes.health_exercise_set (
        id           serial primary key,
        user_id      bigint      not null,
        performed_at timestamptz not null default now(),
        exercise_key text        not null,
        exercise_raw text        not null,
        weight_kg    double precision,
        reps         integer,
        rpe          double precision,
        event_id     bigint,
        created_at   timestamptz not null default now()
      );
      create index if not exists health_exercise_set_lookup
        on hermes.health_exercise_set (user_id, exercise_key, performed_at desc);
    `,
  },

  {
    // Typed targets — the thing adherence is measured against. Deliberately NOT
    // free text in the profile jsonb: code has to divide by these.
    id: '006_target',
    sql: `
      create table if not exists hermes.health_target (
        user_id    bigint not null,
        key        text   not null,
        value      double precision not null,
        unit       text   not null default '',
        cadence    text   not null default 'day',
        updated_at timestamptz not null default now(),
        primary key (user_id, key)
      );
    `,
  },

  {
    // Oura OAuth2 tokens. Personal access tokens were retired in Dec 2025, so
    // the refresh token IS the long-lived credential — it must survive redeploys.
    id: '007_oura_token',
    sql: `
      create table if not exists hermes.oura_token (
        user_id       bigint primary key,
        access_token  text not null,
        refresh_token text not null,
        expires_at    timestamptz not null,
        scope         text not null default '',
        last_sync_day date,
        updated_at    timestamptz not null default now()
      );
    `,
  },

  {
    // Long memory: monthly rollups so the coach can see years, not 14 days.
    id: '008_summary',
    sql: `
      create table if not exists hermes.health_summary (
        user_id      bigint not null,
        period       text   not null,
        period_start date   not null,
        text         text   not null,
        data         jsonb  not null default '{}',
        created_at   timestamptz not null default now(),
        primary key (user_id, period, period_start)
      );
    `,
  },
];
