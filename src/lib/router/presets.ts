/** Built-in providers. All speak the OpenAI chat-completions protocol. */
export const PRESETS: { id: string; name: string; base_url: string | null }[] = [
  { id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api/v1" },
  { id: "gemini", name: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai" },
  { id: "groq", name: "Groq", base_url: "https://api.groq.com/openai/v1" },
  { id: "mistral", name: "Mistral", base_url: "https://api.mistral.ai/v1" },
  { id: "cerebras", name: "Cerebras", base_url: "https://api.cerebras.ai/v1" },
  { id: "custom", name: "Custom", base_url: null },
];
