// Lab-marker time series computed in CODE — every labs row stores
// data.markers[{name,value,unit,ref,flag}]; this flattens them across draws
// into per-marker histories («Vitamin D: 28 (05.06) → 41 (04.08)») so the
// coach compares against the PREVIOUS draw instead of hallucinating a trend.
// Pure + tested.

import { HealthRow } from './store.js';

export interface MarkerPoint {
  date: string; // DD.MM.YY local-ish (from logged_at, UTC date is fine for labs)
  value: number | string;
  unit: string;
  flag: string; // low | high | ok | ''
}

export interface MarkerSeries {
  name: string;
  points: MarkerPoint[]; // oldest-first
}

interface RawMarker {
  name?: unknown;
  value?: unknown;
  unit?: unknown;
  flag?: unknown;
}

const fmtDate = (d: Date): string => {
  const iso = d.toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`;
};

// Normalized key so «Вітамін D», «Vitamin D (25-OH)» and «vitamin d» collapse
// into one series: lowercase, strip everything but letters/digits.
export const markerKey = (name: string): string =>
  name.toLowerCase().replace(/[^a-zа-яїієґ0-9]+/gi, '');

/** Flatten labs rows (oldest-first) into per-marker series. Display name = the
 *  latest spelling seen for the key. */
export function labsTrend(rows: HealthRow[]): MarkerSeries[] {
  const series = new Map<string, MarkerSeries>();
  for (const r of rows) {
    if (r.kind !== 'labs') continue;
    const markers = (r.data as { markers?: RawMarker[] })?.markers;
    if (!Array.isArray(markers)) continue;
    for (const m of markers) {
      const name = String(m?.name ?? '').trim();
      if (!name) continue;
      const key = markerKey(name);
      if (!key) continue;
      const value = typeof m.value === 'number' || typeof m.value === 'string' ? m.value : '';
      if (value === '') continue;
      const existing = series.get(key) ?? { name, points: [] };
      existing.name = name; // latest spelling wins
      existing.points.push({
        date: fmtDate(r.logged_at),
        value,
        unit: String(m.unit ?? ''),
        flag: String(m.flag ?? ''),
      });
      series.set(key, existing);
    }
  }
  return [...series.values()];
}

const flagIcon = (flag: string): string => (flag === 'high' ? '↑' : flag === 'low' ? '↓' : '');

/** Prompt block. Multi-point markers show the trajectory; single-point markers
 *  are honest about having no trend yet. Empty → '' (block simply absent). */
export function serializeLabsTrend(series: MarkerSeries[]): string {
  if (series.length === 0) return '';
  const lines = ['=== ДИНАМІКА МАРКЕРІВ АНАЛІЗІВ (порахована кодом — цитуй ЦІ значення) ==='];
  for (const s of series) {
    const pts = s.points
      .map((p) => `${p.value}${p.unit ? ' ' + p.unit : ''}${flagIcon(p.flag)} (${p.date})`)
      .join(' → ');
    lines.push(`- ${s.name}: ${pts}${s.points.length === 1 ? ' [один забір — тренду ще нема]' : ''}`);
  }
  lines.push('=== КІНЕЦЬ ДИНАМІКИ ===');
  return lines.join('\n');
}
