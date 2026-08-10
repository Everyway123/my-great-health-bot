// The model's output contract, as a tool schema instead of hand-parsed JSON.
//
// v1 asked for "one JSON object, no text around it" and then rescued the result
// with regex when the model wrapped it in a fence or added a sentence. With
// forced tool use the API returns an already-parsed object in `tool_use.input`,
// the schema is enforced at the tool layer, and the whole class of
// "не зміг структурувати" failures disappears.

export const LOG_TOOL_NAME = 'log_health';

const stringArray = { type: 'array', items: { type: 'string' } };

export const LOG_HEALTH_TOOL = {
  name: LOG_TOOL_NAME,
  description:
    'Записати факт про здоровʼя у журнал і відповісти Андрію як коуч. Викликай ЗАВЖДИ — навіть коли вхід не є новим фактом (тоді kind="other").',
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['meal', 'workout', 'sleep', 'weight', 'labs', 'wellbeing', 'note', 'other'],
        description: '"other" — коли це не новий факт про здоровʼя (питання, розмова, підтвердження плану).',
      },
      title: { type: 'string', description: 'Короткий опис факту, 5-12 слів.' },
      data: {
        type: 'object',
        description: 'Структуровані числа. Клади ТІЛЬКИ те, що реально є у вхідних даних.',
        properties: {
          calories: { type: 'number' },
          protein_g: { type: 'number' },
          fat_g: { type: 'number' },
          carbs_g: { type: 'number' },
          items: stringArray,
          alcohol_units: { type: 'number', description: 'Стандартні одиниці алкоголю (1 од. ≈ 10 г етанолу).' },
          workout_type: { type: 'string' },
          duration_min: { type: 'number' },
          intensity: { type: 'string' },
          sets: {
            type: 'array',
            description: 'Підходи силового тренування. Без них прогресію рахувати неможливо — витягуй завжди, коли вони названі.',
            items: {
              type: 'object',
              properties: {
                exercise: { type: 'string' },
                weight_kg: { type: 'number' },
                reps: { type: 'number' },
                rpe: { type: 'number', description: 'Суб’єктивна важкість 1-10, якщо названа.' },
              },
              required: ['exercise'],
            },
          },
          sleep_h: { type: 'number' },
          quality: { type: 'string' },
          weight_kg: { type: 'number' },
          markers: {
            type: 'array',
            description: 'Маркери з бланка аналізів — ВСІ, з одиницями і референсами як надруковано.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                value: { type: 'string' },
                unit: { type: 'string' },
                ref: { type: 'string' },
                flag: { type: 'string', enum: ['low', 'high', 'ok'] },
              },
              required: ['name', 'value'],
            },
          },
        },
      },
      profile_updates: {
        type: 'object',
        description:
          'Довготривалі ПРОЗОВІ факти: зріст, травми, обмеження, вподобання, генетичні риси. Числові цілі сюди НЕ кладуть — для них є targets.',
        properties: {
          height_cm: { type: 'number' },
          birth_year: { type: 'number' },
          injuries: stringArray,
          constraints: stringArray,
          preferences: stringArray,
          goals: stringArray,
          dna_traits: stringArray,
          equipment: stringArray,
          medications: stringArray,
        },
      },
      targets: {
        type: 'object',
        description:
          'Числові цілі, які код звіряє з фактом. Став їх, коли Андрій приймає план або називає ціль. Порожньо — коли нічого не змінилось.',
        properties: {
          protein_g_per_day: { type: 'number' },
          kcal_per_day: { type: 'number' },
          steps_per_day: { type: 'number' },
          sleep_h_per_night: { type: 'number' },
          strength_sessions_per_week: { type: 'number' },
          zone2_min_per_week: { type: 'number' },
          vo2max_sessions_per_week: { type: 'number' },
          alcohol_units_per_week: { type: 'number' },
          weight_kg: { type: 'number' },
        },
      },
      reply: { type: 'string', description: 'Відповідь Андрію як коуча-ментора. Telegram HTML, без markdown.' },
    },
    required: ['kind', 'title', 'reply'],
  },
} as const;

export interface CoachParsed {
  kind: string;
  title: string;
  data: Record<string, unknown>;
  profileUpdates: Record<string, unknown> | null;
  targets: Record<string, unknown> | null;
  reply: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): Record<string, unknown> | null =>
  isObject(v) && Object.keys(v).length > 0 ? v : null;

/** Normalize a tool-use input into the shape the rest of the code expects.
 *  Returns null only when the model produced something unusable. */
export function normalizeToolInput(input: unknown): CoachParsed | null {
  if (!isObject(input)) return null;
  const reply = String(input.reply ?? '').trim();
  const kind = String(input.kind ?? '').trim();
  if (!reply || !kind) return null;
  return {
    kind,
    title: String(input.title ?? '').slice(0, 300),
    data: isObject(input.data) ? input.data : {},
    profileUpdates: nonEmpty(input.profile_updates),
    targets: nonEmpty(input.targets),
    reply,
  };
}
