import type { Db } from "../db";
import { effectiveStatus, getStrategy, setSetting } from "./engine";
import { fetchChatModels } from "./discovery";
import { PRESETS } from "./presets";
import {
  RouterError,
  STRATEGIES,
  type KeyRow,
  type ModelRowDb,
  type ProviderRow,
  type RouterState,
  type Strategy,
  type UiLog,
} from "./types";

export function maskKey(value: string): string {
  return value.length <= 8 ? "••••" : `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/** Everything the Model configuration sidebar shows. Keys are masked here and never leave the server in full. */
export function getRouterState(db: Db, now = new Date()): RouterState {
  const providers = db.prepare("SELECT * FROM llm_providers ORDER BY id").all() as ProviderRow[];
  const keys = db.prepare("SELECT * FROM llm_keys ORDER BY id").all() as KeyRow[];
  const models = db.prepare("SELECT * FROM llm_models ORDER BY priority, id").all() as ModelRowDb[];
  const logs = db.prepare("SELECT * FROM llm_log ORDER BY id DESC LIMIT 30").all() as UiLog[];

  const counts = new Map<number, number>();
  for (const m of models) counts.set(m.key_id, (counts.get(m.key_id) ?? 0) + 1);
  const keyById = new Map(keys.map((k) => [k.id, k]));
  const providerById = new Map(providers.map((p) => [p.id, p]));

  return {
    strategy: getStrategy(db),
    presets: PRESETS,
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      preset: p.preset,
      base_url: p.base_url,
      free_only: !!p.free_only,
      keys: keys
        .filter((k) => k.provider_id === p.id)
        .map((k) => ({
          id: k.id,
          provider_id: k.provider_id,
          label: k.label,
          masked_key: maskKey(k.key_value),
          status: k.status,
          last_error: k.last_error,
          model_count: counts.get(k.id) ?? 0,
        })),
    })),
    models: models.map((m) => {
      const key = keyById.get(m.key_id)!;
      return {
        id: m.id,
        model_id: m.model_id,
        provider: providerById.get(key.provider_id)!.name,
        key_label: key.label,
        enabled: !!m.enabled,
        priority: m.priority,
        status: effectiveStatus(m, key, now),
        cooldown_until: m.cooldown_until,
        last_error: m.last_error ?? (key.status === "disabled" ? key.last_error : null),
      };
    }),
    logs,
  };
}

export interface AddKeyInput {
  preset: string;
  label: string;
  api_key: string;
  base_url?: string;
  name?: string;
}

export function addKey(db: Db, input: AddKeyInput): { id: number } {
  const preset = PRESETS.find((p) => p.id === input.preset);
  if (!preset) throw new RouterError(`Unknown provider "${input.preset}"`, 422);
  const baseUrl = (input.base_url?.trim() || preset.base_url || "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(baseUrl)) throw new RouterError("A base URL starting with http:// or https:// is required", 422);
  const label = input.label.trim();
  const apiKey = input.api_key.trim();
  if (!label || !apiKey) throw new RouterError("Give the key a label and paste the API key", 422);

  const name = input.name?.trim() || (input.preset === "custom" ? new URL(baseUrl).host : preset.name);
  return db.transaction(() => {
    let provider = db.prepare("SELECT id FROM llm_providers WHERE base_url = ?").get(baseUrl) as { id: number } | undefined;
    if (!provider) {
      const info = db.prepare("INSERT INTO llm_providers (name, preset, base_url) VALUES (?, ?, ?)").run(name, input.preset, baseUrl);
      provider = { id: Number(info.lastInsertRowid) };
    }
    const info = db.prepare("INSERT INTO llm_keys (provider_id, label, key_value) VALUES (?, ?, ?)").run(provider.id, label, apiKey);
    return { id: Number(info.lastInsertRowid) };
  })();
}

export function patchKey(db: Db, id: number, patch: { label?: string; status?: "active" | "disabled" }): void {
  const key = db.prepare("SELECT * FROM llm_keys WHERE id = ?").get(id) as KeyRow | undefined;
  if (!key) throw new RouterError("Key not found", 404);
  if (patch.label?.trim()) db.prepare("UPDATE llm_keys SET label = ? WHERE id = ?").run(patch.label.trim(), id);
  if (patch.status) {
    db.prepare("UPDATE llm_keys SET status = ?, last_error = CASE WHEN ? = 'active' THEN NULL ELSE last_error END WHERE id = ?").run(
      patch.status,
      patch.status,
      id,
    );
  }
}

export function deleteKey(db: Db, id: number): void {
  const key = db.prepare("SELECT provider_id FROM llm_keys WHERE id = ?").get(id) as { provider_id: number } | undefined;
  if (!key) throw new RouterError("Key not found", 404);
  db.transaction(() => {
    db.prepare("DELETE FROM llm_keys WHERE id = ?").run(id); // models cascade
    const left = db.prepare("SELECT 1 FROM llm_keys WHERE provider_id = ? LIMIT 1").get(key.provider_id);
    if (!left) db.prepare("DELETE FROM llm_providers WHERE id = ?").run(key.provider_id);
  })();
}

export function patchProvider(db: Db, id: number, patch: { free_only?: boolean }): void {
  const res = db.prepare("UPDATE llm_providers SET free_only = COALESCE(?, free_only) WHERE id = ?").run(
    patch.free_only === undefined ? null : patch.free_only ? 1 : 0,
    id,
  );
  if (!res.changes) throw new RouterError("Provider not found", 404);
}

export function patchModel(db: Db, id: number, patch: { enabled?: boolean; priority?: number }): void {
  const m = db.prepare("SELECT id FROM llm_models WHERE id = ?").get(id);
  if (!m) throw new RouterError("Model not found", 404);
  if (patch.priority !== undefined) db.prepare("UPDATE llm_models SET priority = ? WHERE id = ?").run(patch.priority, id);
  if (patch.enabled !== undefined) {
    // Turning a model back on is an explicit retry: clear its cooldown and error.
    db.prepare(
      `UPDATE llm_models SET enabled = ?,
         status = CASE WHEN ? = 1 THEN 'active' ELSE status END,
         cooldown_until = CASE WHEN ? = 1 THEN NULL ELSE cooldown_until END,
         last_error = CASE WHEN ? = 1 THEN NULL ELSE last_error END
       WHERE id = ?`,
    ).run(patch.enabled ? 1 : 0, patch.enabled ? 1 : 0, patch.enabled ? 1 : 0, patch.enabled ? 1 : 0, id);
  }
}

export function resetCooldowns(db: Db): number {
  return db
    .prepare("UPDATE llm_models SET status = 'active', cooldown_until = NULL WHERE status = 'cooling_down' OR cooldown_until IS NOT NULL")
    .run().changes;
}

export function setStrategy(db: Db, strategy: string): Strategy {
  if (!STRATEGIES.includes(strategy as Strategy)) throw new RouterError(`Strategy must be one of ${STRATEGIES.join(", ")}`, 422);
  setSetting(db, "strategy", strategy);
  return strategy as Strategy;
}

/** Pull the key's chat models. New ones are added; edits to existing ones are kept; ones gone upstream are removed. */
export async function syncKey(
  db: Db,
  id: number,
  fetchFn?: typeof fetch,
): Promise<{ added: number; kept: number; removed: number; total: number }> {
  const key = db.prepare("SELECT * FROM llm_keys WHERE id = ?").get(id) as KeyRow | undefined;
  if (!key) throw new RouterError("Key not found", 404);
  const provider = db.prepare("SELECT * FROM llm_providers WHERE id = ?").get(key.provider_id) as ProviderRow;

  let ids: string[];
  try {
    ids = await fetchChatModels(provider.base_url, key.key_value, {
      freeOnly: provider.preset === "openrouter" && !!provider.free_only,
      fetch: fetchFn,
    });
  } catch (err) {
    db.prepare("UPDATE llm_keys SET last_error = ? WHERE id = ?").run(`sync: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), id);
    throw err;
  }

  return db.transaction(() => {
    const existing = new Set(
      (db.prepare("SELECT model_id FROM llm_models WHERE key_id = ?").all(id) as { model_id: string }[]).map((r) => r.model_id),
    );
    const insert = db.prepare("INSERT INTO llm_models (key_id, model_id) VALUES (?, ?)");
    let added = 0;
    let kept = 0;
    for (const m of ids) {
      if (existing.has(m)) kept++;
      else {
        insert.run(id, m);
        added++;
      }
    }
    let removed = 0;
    const drop = db.prepare("DELETE FROM llm_models WHERE key_id = ? AND model_id = ?");
    for (const m of existing) {
      if (!ids.includes(m)) {
        drop.run(id, m);
        removed++;
      }
    }
    if (key.last_error?.startsWith("sync:")) db.prepare("UPDATE llm_keys SET last_error = NULL WHERE id = ?").run(id);
    return { added, kept, removed, total: added + kept };
  })();
}
