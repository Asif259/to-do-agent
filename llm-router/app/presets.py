"""Built-in provider presets (all OpenAI-compatible)."""

PRESETS: dict[str, dict[str, str | None]] = {
    "openrouter": {"name": "OpenRouter", "base_url": "https://openrouter.ai/api/v1"},
    "gemini": {
        "name": "Google Gemini",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    "groq": {"name": "Groq", "base_url": "https://api.groq.com/openai/v1"},
    "mistral": {"name": "Mistral", "base_url": "https://api.mistral.ai/v1"},
    "cerebras": {"name": "Cerebras", "base_url": "https://api.cerebras.ai/v1"},
    "custom": {"name": "Custom", "base_url": None},
}
