import httpx
import pytest
import respx
from sqlmodel import select

from app.config import Settings
from app.main import create_app
from app.models import ApiKey, ModelEntry, Provider, RequestLog

CHAT = {"model": "auto", "messages": [{"role": "user", "content": "hello"}]}


def ok_response(content: str = "hi") -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "chatcmpl-1",
            "object": "chat.completion",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": content},
                    "finish_reason": "stop",
                }
            ],
        },
    )


def sse_response(*chunks: str) -> httpx.Response:
    body = "".join(f"data: {c}\n\n" for c in chunks) + "data: [DONE]\n\n"
    return httpx.Response(200, content=body.encode(), headers={"content-type": "text/event-stream"})


class Env:
    """A running app, an HTTP client bound to it, and DB helpers."""

    def __init__(self, app, client):
        self.app = app
        self.client = client

    @property
    def sessionmaker(self):
        return self.app.state.sessionmaker

    async def add_model(
        self,
        base_url: str,
        model_id: str = "m",
        *,
        key: str = "sk-test",
        priority: int = 100,
        provider: str | None = None,
        preset: str = "custom",
        label: str | None = None,
    ) -> int:
        """Insert provider, key and model rows directly. Returns the model entry id."""
        async with self.sessionmaker() as s:
            prov = (
                await s.exec(select(Provider).where(Provider.base_url == base_url))
            ).first()
            if prov is None:
                prov = Provider(name=provider or base_url, preset=preset, base_url=base_url)
                s.add(prov)
                await s.commit()
            api_key = (
                await s.exec(
                    select(ApiKey).where(
                        ApiKey.provider_id == prov.id, ApiKey.key_value == key
                    )
                )
            ).first()
            if api_key is None:
                api_key = ApiKey(provider_id=prov.id, label=label or key, key_value=key)
                s.add(api_key)
                await s.commit()
            entry = ModelEntry(key_id=api_key.id, model_id=model_id, priority=priority)
            s.add(entry)
            await s.commit()
            return entry.id

    async def get(self, model, pk):
        async with self.sessionmaker() as s:
            return await s.get(model, pk)

    async def key_of(self, entry_id: int) -> ApiKey:
        entry = await self.get(ModelEntry, entry_id)
        return await self.get(ApiKey, entry.key_id)

    async def logs(self) -> list[RequestLog]:
        async with self.sessionmaker() as s:
            return list((await s.exec(select(RequestLog).order_by(RequestLog.id))).all())

    async def chat(self, **overrides):
        return await self.client.post("/v1/chat/completions", json={**CHAT, **overrides})


async def _make_env(tmp_path, **settings):
    settings = Settings(db_url=f"sqlite+aiosqlite:///{tmp_path / 'test.db'}", **settings)
    return create_app(settings)


@pytest.fixture
async def env(tmp_path):
    app = await _make_env(tmp_path)
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://router") as client:
            yield Env(app, client)


@pytest.fixture
async def secured_env(tmp_path):
    app = await _make_env(tmp_path, proxy_api_key="sekret")
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://router") as client:
            yield Env(app, client)


@pytest.fixture
def upstream():
    """Mocks every outbound httpx call made by the app. The test client uses ASGITransport, which respx does not touch."""
    with respx.mock(assert_all_called=False) as mock:
        yield mock
