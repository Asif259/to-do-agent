export class RouterError extends Error {
  constructor(
    message: string,
    /** HTTP status to use when this reaches an API route. */
    readonly status = 500,
  ) {
    super(message);
    this.name = "RouterError";
  }
}

export interface ProviderRow {
  id: number;
  name: string;
  preset: string;
  base_url: string;
  free_only: number;
}

export interface KeyRow {
  id: number;
  provider_id: number;
  label: string;
  key_value: string;
  status: "active" | "disabled";
  last_error: string | null;
}

export interface ModelRowDb {
  id: number;
  key_id: number;
  model_id: string;
  enabled: number;
  priority: number;
  status: "active" | "cooling_down" | "disabled";
  cooldown_until: string | null;
  last_error: string | null;
}

/** One eligible (key, model) pair with what is needed to call it. */
export interface Candidate {
  id: number;
  model_id: string;
  key_id: number;
  key_label: string;
  key_value: string;
  provider_name: string;
  base_url: string;
}

export const label = (c: Pick<Candidate, "provider_name" | "model_id">) => `${c.provider_name}/${c.model_id}`;

export type Strategy = "waterfall" | "round_robin";
export const STRATEGIES: readonly Strategy[] = ["waterfall", "round_robin"];

// ---- what the sidebar receives (keys always masked)

export interface UiKey {
  id: number;
  provider_id: number;
  label: string;
  masked_key: string;
  status: "active" | "disabled";
  last_error: string | null;
  model_count: number;
}

export interface UiProvider {
  id: number;
  name: string;
  preset: string;
  base_url: string;
  free_only: boolean;
  keys: UiKey[];
}

export interface UiModel {
  id: number;
  model_id: string;
  provider: string;
  key_label: string;
  enabled: boolean;
  priority: number;
  status: "active" | "cooling_down" | "disabled";
  cooldown_until: string | null;
  last_error: string | null;
}

export interface UiLog {
  id: number;
  ts: string;
  role: string;
  provider: string | null;
  model: string | null;
  status_code: number;
  latency_ms: number;
  attempts: number;
  note: string | null;
}

export interface RouterState {
  strategy: Strategy;
  presets: { id: string; name: string; base_url: string | null }[];
  providers: UiProvider[];
  models: UiModel[];
  logs: UiLog[];
}
