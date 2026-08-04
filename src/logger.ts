// Structured JSON logger — one line per event (Railway parses the JSON into
// log attributes). Error-level entries additionally go to the alert sink
// (Telegram) so a failing cron/handler surfaces in minutes, not never —
// the same observability lesson Hermes learned the hard way.

export interface LogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  action: string;
  userId?: number;
  details?: Record<string, unknown>;
}

type AlertSink = (entry: LogEntry) => void;
let alertSink: AlertSink | null = null;
export function setAlertSink(fn: AlertSink | null): void {
  alertSink = fn;
}

export function log(entry: Omit<LogEntry, 'timestamp'>): void {
  const full: LogEntry = { timestamp: new Date().toISOString(), ...entry };
  console.log(JSON.stringify(full));
  if (full.level === 'error' && alertSink) {
    try {
      alertSink(full);
    } catch {
      /* alerting must never break the caller */
    }
  }
}
