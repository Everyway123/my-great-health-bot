export interface AppConfig {
  botToken: string;
  allowedUserIds: number[];
  anthropicApiKey: string;
  databaseUrl: string;
  timezone: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Parse + VALIDATE the allowlist — parseInt('abc') → NaN would silently make
// every send target NaN with zero Telegram signal. Fail closed on malformed ids.
function loadAllowedUserIds(): number[] {
  const ids = requireEnv('ALLOWED_USER_IDS')
    .split(',')
    .map((id) => parseInt(id.trim(), 10));
  if (ids.length === 0 || ids.some((n) => !Number.isFinite(n))) {
    throw new Error(`ALLOWED_USER_IDS malformed (non-integer id): ${JSON.stringify(process.env.ALLOWED_USER_IDS)}`);
  }
  return ids;
}

export function loadConfig(): AppConfig {
  return {
    botToken: requireEnv('TELEGRAM_BOT_TOKEN'),
    allowedUserIds: loadAllowedUserIds(),
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    databaseUrl: process.env.DATABASE_URL || '',
    timezone: process.env.TIMEZONE || 'Europe/Lisbon',
  };
}
