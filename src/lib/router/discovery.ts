import { RouterError } from "./types";

/** Substrings that mark a model as not usable for chat. */
const EXCLUDED = ["embed", "whisper", "tts", "dall-e", "dalle", "moderation", "audio", "rerank", "transcribe", "speech", "imagen", "veo-"];

interface ModelItem {
  id: string;
  architecture?: { output_modalities?: string[]; modality?: string };
}

export function isChatModel(item: ModelItem): boolean {
  const id = item.id.toLowerCase();
  if (!id || EXCLUDED.some((bad) => id.includes(bad))) return false;
  const outputs = item.architecture?.output_modalities; // OpenRouter reports modalities
  if (outputs && !outputs.includes("text")) return false;
  const modality = item.architecture?.modality;
  if (typeof modality === "string" && modality.includes("->") && !modality.split("->").at(-1)!.includes("text")) return false;
  return true;
}

function items(payload: unknown): ModelItem[] {
  const raw = Array.isArray(payload)
    ? payload
    : ((payload as { data?: unknown; models?: unknown } | null)?.data ?? (payload as { models?: unknown } | null)?.models ?? []);
  const out: ModelItem[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (typeof entry === "string") out.push({ id: entry });
    else if (entry && typeof entry === "object") {
      const e = entry as { id?: unknown; name?: unknown; architecture?: ModelItem["architecture"] };
      const id = e.id ?? e.name;
      if (typeof id === "string" && id) out.push({ id, architecture: e.architecture });
    }
  }
  return out;
}

/** Ask a provider which chat models this key can use. */
export async function fetchChatModels(
  baseUrl: string,
  apiKey: string,
  opts: { freeOnly: boolean; fetch?: typeof fetch },
): Promise<string[]> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new RouterError(`Could not reach ${url} (${err instanceof Error ? err.message : String(err)})`, 502);
  }
  if (!res.ok) {
    const detail = (await res.text()).replace(/\s+/g, " ").slice(0, 160);
    throw new RouterError(`HTTP ${res.status}: ${detail}`, 502);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new RouterError("The provider returned invalid JSON for its model list", 502);
  }
  const ids: string[] = [];
  for (const item of items(payload)) {
    if (!isChatModel(item)) continue;
    if (opts.freeOnly && !item.id.endsWith(":free")) continue;
    if (!ids.includes(item.id)) ids.push(item.id);
  }
  return ids;
}
