// Critical lab values — the one place where code overrides the model.
//
// Clinical labs keep a "panic value" list: results so far out of range that the
// technician phones the physician immediately rather than filing a report. We
// keep a small version of the same idea. If a marker crosses one of these, the
// warning is emitted regardless of what the model decided to say — a prompt
// instruction is not an acceptable safety mechanism, because a prompt can be
// out-reasoned and a threshold cannot.
//
// This is a FLOOR, not a diagnosis: it catches the unmissable, and it never
// implies that a value inside these bounds is fine. Thresholds below are common
// published panic values; they are worth confirming with Andrii's physician,
// and they are deliberately conservative (wide) to avoid crying wolf.

export interface CriticalRule {
  markerKey: string;
  /** unit fragment this rule applies to, lowercased and stripped of spaces */
  unit: string;
  low?: number;
  high?: number;
  label: string;
}

const norm = (s: string): string => s.toLowerCase().replace(/[\s]/g, '');

export const CRITICAL_RULES: CriticalRule[] = [
  { markerKey: 'калій', unit: 'mmol/l', low: 2.5, high: 6.5, label: 'Калій' },
  { markerKey: 'potassium', unit: 'mmol/l', low: 2.5, high: 6.5, label: 'Potassium' },
  { markerKey: 'натрій', unit: 'mmol/l', low: 120, high: 160, label: 'Натрій' },
  { markerKey: 'sodium', unit: 'mmol/l', low: 120, high: 160, label: 'Sodium' },
  { markerKey: 'глюкоза', unit: 'mmol/l', low: 2.8, high: 25, label: 'Глюкоза' },
  { markerKey: 'glucose', unit: 'mmol/l', low: 2.8, high: 25, label: 'Glucose' },
  { markerKey: 'глюкоза', unit: 'mg/dl', low: 50, high: 450, label: 'Глюкоза' },
  { markerKey: 'glucose', unit: 'mg/dl', low: 50, high: 450, label: 'Glucose' },
  { markerKey: 'гемоглобін', unit: 'g/l', low: 70, label: 'Гемоглобін' },
  { markerKey: 'hemoglobin', unit: 'g/l', low: 70, label: 'Hemoglobin' },
  { markerKey: 'гемоглобін', unit: 'g/dl', low: 7, label: 'Гемоглобін' },
  { markerKey: 'hemoglobin', unit: 'g/dl', low: 7, label: 'Hemoglobin' },
  { markerKey: 'тромбоцити', unit: '10^9/l', low: 20, high: 1000, label: 'Тромбоцити' },
  { markerKey: 'platelets', unit: '10^9/l', low: 20, high: 1000, label: 'Platelets' },
  { markerKey: 'кальцій', unit: 'mmol/l', low: 1.6, high: 3.5, label: 'Кальцій' },
  { markerKey: 'calcium', unit: 'mmol/l', low: 1.6, high: 3.5, label: 'Calcium' },
];

export interface CriticalHit {
  label: string;
  value: number;
  unit: string;
  direction: 'low' | 'high';
  threshold: number;
}

export interface MarkerReading {
  markerKey: string;
  nameRaw: string;
  value: number | null;
  unit: string;
}

/** Pure. Empty array = nothing crossed a panic threshold (which is NOT the same
 *  as "everything is fine"). */
export function checkCritical(readings: MarkerReading[]): CriticalHit[] {
  const hits: CriticalHit[] = [];
  for (const r of readings) {
    if (r.value === null || !Number.isFinite(r.value)) continue;
    const unit = norm(r.unit);
    if (!unit) continue;
    for (const rule of CRITICAL_RULES) {
      if (!r.markerKey.includes(norm(rule.markerKey))) continue;
      if (norm(rule.unit) !== unit) continue;
      if (rule.low !== undefined && r.value < rule.low) {
        hits.push({ label: r.nameRaw || rule.label, value: r.value, unit: r.unit, direction: 'low', threshold: rule.low });
      } else if (rule.high !== undefined && r.value > rule.high) {
        hits.push({ label: r.nameRaw || rule.label, value: r.value, unit: r.unit, direction: 'high', threshold: rule.high });
      }
    }
  }
  return hits;
}

/** Prepended to the reply, above whatever the model wrote. Deliberately blunt
 *  and deliberately not a diagnosis. */
export function formatCriticalWarning(hits: CriticalHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map(
    (h) =>
      `• <b>${h.label}: ${h.value} ${h.unit}</b> — ${h.direction === 'low' ? 'критично низько' : 'критично високо'} (поріг ${h.threshold})`,
  );
  return [
    '🚨 <b>ТЕРМІНОВО ДО ЛІКАРЯ</b>',
    ...lines,
    '<i>Такі значення в лабораторній практиці означають негайний контакт із лікарем. Я не ставлю діагнозів — але це не той випадок, коли чекають планового візиту. Якщо самопочуття різко погане — швидка допомога.</i>',
    '',
  ].join('\n');
}
