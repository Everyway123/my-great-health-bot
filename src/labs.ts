// Lab markers as a real time series.
//
// v1 flattened markers out of the jsonb blob on every request. That works for
// two draws and falls apart at fifteen across ten years — and it silently
// splits «Вітамін D», «25-OH D» and «Vitamin D3» into three unrelated markers,
// which is exactly the point at which a longevity trend stops existing.
//
// Now: normalized rows in hermes.health_lab_marker, one synonym dictionary, and
// pure functions over the result.

import { getPool } from './store.js';
import { log } from './logger.js';
import { MarkerReading } from './domain/safety.js';

/** Synonym groups → canonical key. Order matters only for readability; matching
 *  is on the normalized form of each alias. */
const SYNONYMS: Record<string, string[]> = {
  vitamin_d: ['вітамін d', 'витамин d', 'vitamin d', '25-oh', '25 oh vitamin d', '25(oh)d', 'vitamin d3', 'кальцидіол'],
  apob: ['apob', 'апоб', 'аполіпопротеїн b', 'apolipoprotein b'],
  lpa: ['lp(a)', 'lpa', 'ліпопротеїн a', 'lipoprotein a'],
  ldl: ['ldl', 'лпнщ', 'холестерин лпнп', 'ldl cholesterol'],
  hdl: ['hdl', 'лпвщ', 'холестерин лпвп', 'hdl cholesterol'],
  triglycerides: ['тригліцериди', 'triglycerides', 'тг'],
  total_cholesterol: ['загальний холестерин', 'холестерин загальний', 'total cholesterol'],
  hba1c: ['hba1c', 'глікований гемоглобін', 'глікозильований гемоглобін', 'a1c'],
  glucose: ['глюкоза', 'glucose', 'цукор крові'],
  insulin: ['інсулін', 'insulin'],
  hs_crp: ['hs-crp', 'hscrp', 'срб високочутливий', 'с-реактивний білок високочутливий', 'high sensitivity crp'],
  crp: ['срб', 'с-реактивний білок', 'crp', 'c-reactive protein'],
  ferritin: ['феритин', 'ferritin'],
  homocysteine: ['гомоцистеїн', 'homocysteine'],
  tsh: ['ттг', 'tsh', 'тиреотропний'],
  testosterone: ['тестостерон', 'testosterone'],
  b12: ['b12', 'вітамін b12', 'кобаламін', 'cobalamin'],
  folate: ['фолат', 'фолієва', 'folate', 'folic acid'],
  alt: ['алт', 'alt', 'аланінамінотрансфераза'],
  ast: ['аст', 'ast', 'аспартатамінотрансфераза'],
  ggt: ['ггт', 'ggt', 'гамма-глутаміл'],
  creatinine: ['креатинін', 'creatinine'],
  egfr: ['egfr', 'шкф', 'скф'],
  uric_acid: ['сечова кислота', 'uric acid'],
  magnesium: ['магній', 'magnesium'],
  potassium: ['калій', 'potassium'],
  sodium: ['натрій', 'sodium'],
  calcium: ['кальцій', 'calcium'],
  hemoglobin: ['гемоглобін', 'hemoglobin', 'hgb', 'hb'],
  platelets: ['тромбоцити', 'platelets', 'plt'],
  omega3_index: ['омега-3 індекс', 'omega-3 index', 'omega 3 index'],
};

const normalize = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-zа-яїієґё0-9()\-]+/gi, ' ')
    .trim()
    .replace(/\s+/g, ' ');

const ALIAS_TO_KEY: Array<{ alias: string; key: string }> = Object.entries(SYNONYMS)
  .flatMap(([key, aliases]) => aliases.map((alias) => ({ alias: normalize(alias), key })))
  // Longest alias first, so «срб високочутливий» wins over «срб».
  .sort((a, b) => b.alias.length - a.alias.length);

/** Canonical marker key. Falls back to a squashed form of the raw name so an
 *  unknown marker still forms a consistent series with itself. */
export function markerKey(name: string): string {
  const n = normalize(name);
  if (!n) return '';
  for (const { alias, key } of ALIAS_TO_KEY) {
    if (n.includes(alias)) return key;
  }
  return n.replace(/[^a-zа-яїієґё0-9]+/gi, '');
}

export interface RawMarker {
  name?: unknown;
  value?: unknown;
  unit?: unknown;
  ref?: unknown;
  flag?: unknown;
}

export interface MarkerRow {
  markerKey: string;
  nameRaw: string;
  valueNum: number | null;
  valueText: string | null;
  unit: string;
  refRaw: string;
  flag: string;
  drawnAt: Date;
}

const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const m = v.replace(',', '.').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};

/** Pure: model output → storable rows. Markers without a usable name are dropped. */
export function toMarkerRows(markers: unknown, drawnAt: Date): MarkerRow[] {
  if (!Array.isArray(markers)) return [];
  const out: MarkerRow[] = [];
  const seen = new Set<string>();
  for (const raw of markers as RawMarker[]) {
    const nameRaw = String(raw?.name ?? '').trim();
    if (!nameRaw) continue;
    const key = markerKey(nameRaw);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const valueNum = toNumber(raw?.value);
    out.push({
      markerKey: key,
      nameRaw: nameRaw.slice(0, 200),
      valueNum,
      valueText: valueNum === null ? String(raw?.value ?? '').slice(0, 100) || null : null,
      unit: String(raw?.unit ?? '').slice(0, 40),
      refRaw: String(raw?.ref ?? '').slice(0, 100),
      flag: ['low', 'high', 'ok'].includes(String(raw?.flag)) ? String(raw?.flag) : '',
      drawnAt,
    });
  }
  return out;
}

export async function saveMarkers(userId: number, rows: MarkerRow[], eventId: number | null): Promise<number> {
  const p = getPool();
  if (!p || rows.length === 0) return 0;
  try {
    const res = await p.query(
      `insert into hermes.health_lab_marker
         (user_id, drawn_at, marker_key, name_raw, value_num, value_text, unit, ref_raw, flag, event_id)
       select $1, $2, k, n, vn, vt, u, r, f, $3
         from unnest($4::text[], $5::text[], $6::double precision[], $7::text[], $8::text[], $9::text[], $10::text[])
              as t(k, n, vn, vt, u, r, f)
       on conflict (user_id, marker_key, drawn_at) do update
         set value_num = excluded.value_num, value_text = excluded.value_text,
             unit = excluded.unit, ref_raw = excluded.ref_raw, flag = excluded.flag`,
      [
        userId,
        rows[0].drawnAt,
        eventId,
        rows.map((r) => r.markerKey),
        rows.map((r) => r.nameRaw),
        rows.map((r) => r.valueNum),
        rows.map((r) => r.valueText),
        rows.map((r) => r.unit),
        rows.map((r) => r.refRaw),
        rows.map((r) => r.flag),
      ],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    log({ level: 'error', action: 'lab_marker_save_error', details: { error: String(err).slice(0, 200) } });
    return 0;
  }
}

export interface MarkerPoint {
  drawnAt: Date;
  value: number | string;
  unit: string;
  flag: string;
}

export interface MarkerSeries {
  key: string;
  name: string;
  points: MarkerPoint[]; // oldest-first
}

/** Whole history, not a rolling window: a marker measured twice five years apart
 *  is exactly the comparison that matters for longevity. */
export async function fetchMarkerSeries(userId: number): Promise<MarkerSeries[]> {
  const p = getPool();
  if (!p) return [];
  try {
    const res = await p.query<{
      marker_key: string;
      name_raw: string;
      value_num: string | null;
      value_text: string | null;
      unit: string;
      flag: string;
      drawn_at: Date;
    }>(
      `select marker_key, name_raw, value_num, value_text, unit, flag, drawn_at
         from hermes.health_lab_marker
        where user_id = $1
        order by marker_key asc, drawn_at asc`,
      [userId],
    );
    const map = new Map<string, MarkerSeries>();
    for (const r of res.rows) {
      const s = map.get(r.marker_key) ?? { key: r.marker_key, name: r.name_raw, points: [] };
      s.name = r.name_raw; // latest spelling wins
      s.points.push({
        drawnAt: r.drawn_at,
        value: r.value_num !== null ? Number(r.value_num) : (r.value_text ?? ''),
        unit: r.unit,
        flag: r.flag,
      });
      map.set(r.marker_key, s);
    }
    return [...map.values()];
  } catch (err) {
    log({ level: 'error', action: 'lab_marker_fetch_error', details: { error: String(err).slice(0, 200) } });
    return [];
  }
}

/** Latest reading per marker — what the safety layer checks. */
export function latestReadings(series: MarkerSeries[]): MarkerReading[] {
  return series
    .map((s) => {
      const last = s.points[s.points.length - 1];
      if (!last) return null;
      return {
        markerKey: s.key,
        nameRaw: s.name,
        value: typeof last.value === 'number' ? last.value : null,
        unit: last.unit,
      };
    })
    .filter((r): r is MarkerReading => r !== null);
}

/** Markers last seen out of range, and how long ago — feeds the follow-up
 *  trigger so an abnormal result can't just quietly scroll out of view. */
export function staleFlagged(series: MarkerSeries[], now = new Date()): Array<{ name: string; daysAgo: number }> {
  const out: Array<{ name: string; daysAgo: number }> = [];
  for (const s of series) {
    const last = s.points[s.points.length - 1];
    if (!last || (last.flag !== 'low' && last.flag !== 'high')) continue;
    const daysAgo = Math.floor((now.getTime() - last.drawnAt.getTime()) / 86_400_000);
    out.push({ name: s.name, daysAgo });
  }
  return out;
}

const fmtDate = (d: Date): string => {
  const iso = d.toISOString();
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`;
};

const flagIcon = (flag: string): string => (flag === 'high' ? '↑' : flag === 'low' ? '↓' : '');

export function serializeMarkerSeries(series: MarkerSeries[]): string {
  if (series.length === 0) return '';
  const lines = ['=== ДИНАМІКА МАРКЕРІВ (пораховано кодом — цитуй ЦІ значення) ==='];
  for (const s of series) {
    // Long histories: keep the first point as the anchor plus the last four.
    const pts = s.points.length > 5 ? [s.points[0], ...s.points.slice(-4)] : s.points;
    const gap = s.points.length > 5 ? ' … ' : ' → ';
    const rendered = pts
      .map((p) => `${p.value}${p.unit ? ' ' + p.unit : ''}${flagIcon(p.flag)} (${fmtDate(p.drawnAt)})`)
      .join(s.points.length > 5 ? gap : ' → ');
    lines.push(`- ${s.name}: ${rendered}${s.points.length === 1 ? ' [один забір — тренду ще нема]' : ''}`);
  }
  lines.push('=== КІНЕЦЬ ДИНАМІКИ ===');
  return lines.join('\n');
}
