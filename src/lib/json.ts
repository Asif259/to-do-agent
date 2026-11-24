/** Pull the first balanced JSON object out of a model reply (handles code fences and chatter). */
export function extractJson(raw: string): unknown {
  const text = raw.replace(/```(?:json)?/gi, "");
  const start = text.indexOf("{");
  if (start === -1) throw new Error("no JSON object found in reply");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      const candidate = text.slice(start, i + 1);
      try {
        return JSON.parse(candidate);
      } catch {
        // Common model slip: trailing commas.
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, "$1"));
      }
    }
  }
  throw new Error("JSON object in reply is not closed");
}
