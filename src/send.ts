const LIMIT = 4096;

/** Split at newlines so each chunk is <= LIMIT chars. Hard-splits a single overlong line. */
export function chunkMessage(text: string, limit = LIMIT): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const candidate = cur ? `${cur}\n${line}` : line;
    if (candidate.length <= limit) {
      cur = candidate;
      continue;
    }
    if (cur) chunks.push(cur);
    cur = "";
    let rest = line;
    while (rest.length > limit) {
      chunks.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    cur = rest;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export async function sendTelegram(text: string, opts: { token: string; chatId: string }): Promise<void> {
  const url = `https://api.telegram.org/bot${opts.token}/sendMessage`;
  for (const chunk of chunkMessage(text)) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: opts.chatId,
        text: chunk,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      // Fall back to plain text if Telegram rejects the HTML (unbalanced tags etc.).
      if (res.status === 400 && /parse/i.test(body)) {
        const retry = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: opts.chatId, text: chunk, disable_web_page_preview: true }),
        });
        if (retry.ok) {
          console.error(`[send] HTML rejected, sent as plain text: ${body.slice(0, 200)}`);
          continue;
        }
      }
      throw new Error(`Telegram sendMessage failed: HTTP ${res.status} ${body.slice(0, 300)}`);
    }
  }
}
