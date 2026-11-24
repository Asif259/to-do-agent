/** Turn pasted text into task titles: one per line, bullets and numbering stripped. */
export function parseLines(text: string, max = 100): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^\s*\[[ xX]?\]\s*/, "").trim())
    .filter(Boolean)
    .map((line) => line.slice(0, 500))
    .slice(0, max);
}
