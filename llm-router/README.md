# LLM Router

A local, OpenAI-compatible proxy that pools many free-tier API keys. When a key hits a rate limit, runs out of credit, or a provider has an outage, the next request moves to the next key or model automatically.

Point any tool that accepts a custom OpenAI `base_url` at `http://localhost:8000/v1` and use the model name `auto`.

## Run

Requires Python 3.11+.

```bash
cd llm-router
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env            # optional
.venv/bin/uvicorn app.main:app --port 8000
```

Open <http://localhost:8000/> for the dashboard. Settings are read from `.env` or the environment (see [.env.example](.env.example)). If port 8000 is taken, change `--port` and use that port everywhere below.

First use:

1. **Keys & providers**: pick a preset, add a label and your API key.
2. **Sync models** on the key. Non-chat models (embeddings, whisper, tts, image, moderation, audio) are filtered out.
3. Optional: set priorities in the model pool, or switch to round-robin.
4. Try it in the **Playground**.

## Connect clients

**Python**

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8000/v1", api_key="anything")  # or your PROXY_API_KEY
reply = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello"}],
)
print(reply.choices[0].message.content)
```

**JavaScript**

```js
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8000/v1", apiKey: "anything" });
const reply = await client.chat.completions.create({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
});
```

**curl** (response headers show which model answered)

```bash
curl -i http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Hello"}]}'
```

**IDEs.** The names of the settings vary by version; the values do not.

| Tool | Where | Values |
|---|---|---|
| Cursor | Settings → Models → OpenAI API Key, override base URL | Base URL `http://localhost:8000/v1`, key = your `PROXY_API_KEY` (or any text if unset), add model `auto` |
| Continue | `config.yaml` / `config.json` model entry | provider `openai`, `apiBase: http://localhost:8000/v1`, `model: auto`, `apiKey: …` |
| Cline | Provider "OpenAI Compatible" | Base URL `http://localhost:8000/v1`, key, Model ID `auto` |

You can also request a specific model id from `GET /v1/models`. Only entries with that exact id are tried, so the same model on several keys still fails over between keys.

## How routing works

An entry is one `(key, model)` pair. It is eligible when it is enabled, its key is active, its status is not `disabled`, and its cooldown has passed.

| Upstream result | What the router does |
|---|---|
| `429` | Cool that entry down: `Retry-After` if sent, else until next UTC midnight when the body mentions a daily quota, else 60 s. Try the next entry. |
| `401`, `402` | Disable the **key** (all its models) and record the error. Try the next entry. |
| `403`, `404` | Disable that **entry** only. Try the next entry. |
| `408`, `5xx`, timeout, connection error | Cool that entry down for 30 s. Try the next entry. |
| Other `4xx` (for example `400`) | Your request is at fault. Returned as is, no penalty, no retry. |
| Nothing left | `503` in OpenAI error format with the earliest time an entry returns, plus `Retry-After`. |

Strategies: **Waterfall** (default, lowest priority number first) and **Round-robin** (rotates through eligible entries).

**Streaming.** The router reads the first chunk from the upstream before it commits to it, so a failure before the first token still fails over. After the first chunk a failure cannot be retried: the stream ends with an SSE `error` event.

Every response carries `X-Router-Provider`, `X-Router-Model` and `X-Router-Attempts`.

## Security

- Set `PROXY_API_KEY` to require `Authorization: Bearer <key>` on `/v1/*` and `/admin/*`. The dashboard asks for it once and keeps it in the browser's local storage.
- The server binds to `127.0.0.1` by default. Do not expose it to a network without `PROXY_API_KEY` and TLS in front.
- Provider keys are stored **unencrypted** in the local SQLite file (`router.db`). The API and dashboard only show them masked. Protect the file like a password store.

## Tests

```bash
.venv/bin/python -m pytest
```

Covers `429` (with and without `Retry-After`, daily quota), `401`, `402`, `403`, `503`, timeouts, `400` passthrough, exhaustion, streaming failover, both strategies, model discovery filters, and auth. Upstreams are mocked with `respx`.

## Layout

```
app/
  main.py            app factory, static dashboard
  api_v1.py          /v1/chat/completions, /v1/models
  api_admin.py       /admin/* JSON API used by the dashboard
  proxy.py           forwarding, retry loop, streaming gate
  router_engine.py   selection, strategies, failure rules, cooldowns
  discovery.py       model sync and chat-model filter
  models.py db.py config.py auth.py errors.py presets.py
  static/index.html  dashboard (Tailwind CDN + Alpine.js, no build step)
tests/
```
