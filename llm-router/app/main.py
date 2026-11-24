"""FastAPI app factory. Run with: uvicorn app.main:app"""

from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.responses import FileResponse

from app.api_admin import router as admin_router
from app.api_v1 import router as v1_router
from app.config import Settings
from app.db import init_db, make_engine, make_sessionmaker
from app.errors import OpenAIError, openai_error_handler

STATIC = Path(__file__).parent / "static"


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        engine = make_engine(settings.db_url)
        await init_db(engine)
        app.state.engine = engine
        app.state.sessionmaker = make_sessionmaker(engine)
        app.state.client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.read_timeout, connect=settings.connect_timeout)
        )
        try:
            yield
        finally:
            await app.state.client.aclose()
            await engine.dispose()

    app = FastAPI(title="LLM Router", lifespan=lifespan)
    app.state.settings = settings
    app.add_exception_handler(OpenAIError, openai_error_handler)
    app.include_router(v1_router)
    app.include_router(admin_router)

    @app.get("/", include_in_schema=False)
    async def dashboard():
        return FileResponse(STATIC / "index.html")

    return app


app = create_app()
