// Telegram silently rejects a single sendMessage over 4096 chars — every send
// path must chunk. Splits on line boundaries with a safety margin.
export function splitMessage(msg: string, max = 3900): string[] {
  if (msg.length <= max) return [msg];
  const chunks: string[] = [];
  let cur = '';
  for (const line of msg.split('\n')) {
    if (cur.length + line.length + 1 > max) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur = cur ? `${cur}\n${line}` : line;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}
