/** Presentation only: never derives market facts, decisions or diagnostic severity. */
export const TELEGRAM_TEXT_LIMIT = 4000;

export const escapeTelegramHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const TERM_LABELS: Record<string, string> = {
  STAND_ASIDE: "Menunggu di luar pasar / Stand Aside",
  VOLATILITY_EXPANSION: "Volatilitas melebar",
  WAIT_CONFIRMATION: "Menunggu konfirmasi",
  NO_SETUP: "Belum ada setup",
  NO_DATA: "Data belum tersedia",
  TREND_CONTINUATION: "Kelanjutan tren",
  NOT_EVALUABLE: "Belum dapat dievaluasi",
  PULLBACK: "Koreksi sementara",
  TRANSITION: "Fase peralihan",
};

export function readableEngineText(text: string): string {
  return text.replace(/\b(?:STAND_ASIDE|VOLATILITY_EXPANSION|WAIT_CONFIRMATION|NO_SETUP|NO_DATA|TREND_CONTINUATION|NOT_EVALUABLE|PULLBACK|TRANSITION)\b/g,
    (term) => `${TERM_LABELS[term]} (${term})`);
}

function cleanMarkdown(text: string): string {
  return text.replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/^\s*```[^\n]*\n?/gm, "")
    .split("\n").map((line) => {
      if (/^\s*(?:-{2,}|\*{3,}|_{3,})\s*$/.test(line)) return "";
      return line.replace(/^\s*#{1,6}\s+(.+)$/, "**$1**")
        .replace(/^\s*(?:(?:[-*•–—]+|\d+[.)])\s+)+/, "• ")
        .replace(/\s+-{2,}\s+/g, " — ").trimEnd();
    }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Raw AI HTML is always escaped; only tags created by this converter are trusted. */
export function markdownToTelegramHtml(text: string): string {
  const clean = cleanMarkdown(text);
  const parts = clean.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  const html = parts.map((part) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return `<code>${escapeTelegramHtml(part.slice(1, -1))}</code>`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return `<b>${escapeTelegramHtml(part.slice(2, -2).replace(/[`*]/g, ""))}</b>`;
    return escapeTelegramHtml(part.replace(/[`*]/g, ""));
  }).join("");
  return limitTelegramHtml(html);
}

/** Input is generated Telegram HTML, not raw AI text. Decode once for plain-text delivery. */
export function telegramHtmlToPlainText(html: string): string {
  return cleanMarkdown(html.replace(/<\/?(?:b|i|code|pre|u|s)>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&"))
    .replace(/[`*]/g, "").slice(0, TELEGRAM_TEXT_LIMIT);
}

/** Truncate on token boundaries, preserving complete entities, Unicode characters and balanced tags. */
export function limitTelegramHtml(html: string): string {
  if (html.length <= TELEGRAM_TEXT_LIMIT) return html;
  const stack: string[] = [];
  let result = "";
  for (const token of html.match(/<\/?(?:b|i|code|pre|u|s)>|&(?:amp|lt|gt|quot|#39);|[\s\S]/gu) ?? []) {
    const open = token.match(/^<(b|i|code|pre|u|s)>$/)?.[1];
    const close = token.match(/^<\/(b|i|code|pre|u|s)>$/)?.[1];
    const next = [...stack];
    if (open) next.push(open);
    if (close && next.at(-1) === close) next.pop();
    const reserved = next.reduce((sum, tag) => sum + tag.length + 3, 0);
    if (result.length + token.length + reserved + 1 > TELEGRAM_TEXT_LIMIT) break;
    result += token;
    stack.splice(0, stack.length, ...next);
  }
  return `${result}…${stack.reverse().map((tag) => `</${tag}>`).join("")}`;
}