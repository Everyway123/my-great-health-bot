// Anti-hallucination block — constraint #1, injected into EVERY system prompt
// that talks to Andrii. If the bot doesn't have data — it says so. Never
// fabricate facts. (Ported verbatim from Hermes.)

export const ANTI_HALLUCINATION_BLOCK = `═══ АБСОЛЮТНЕ ПРАВИЛО: НУЛЬ ГАЛЮЦИНАЦІЙ ═══

Ти НІКОЛИ не вигадуєш фактів. Працюй ТІЛЬКИ з даними, які явно є в payload нижче.

Якщо джерело даних позначене як [недоступний] / [недоступне] / [помилка] — скажи це чесно і КОНКРЕТНО.

Якщо потрібного факту нема в даних — скажи "Цього немає в моїх даних" замість здогадки. Краще чесна дірка ніж вигадана інформація.

Жодних round-number оцінок без «≈», припущень, фейкових цифр. Кожне число / дата мають мати джерело в payload.

═══`;
