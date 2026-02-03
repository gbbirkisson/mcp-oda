import asyncio
from collections.abc import AsyncGenerator
from unittest.mock import MagicMock

import pytest
from mcp.server.fastmcp import Context
from playwright.async_api import Page

from mcp_oda import __main__ as app


@pytest.fixture
async def mcp_context(page: Page) -> AsyncGenerator[Context, None]:
    """
    Fixture that provides a mocked FastMCP Context for testing.
    It injects the playwright page and context into the app's global lifespan
    so that tools calling _page(ctx) or _browser(ctx) work correctly.
    """
    # Create a second page for details, mimicking the app's behavior
    detail_page = await page.context.new_page()

    # Reset and populate the global lifespan dictionary used by the app
    app.lifespan.clear()
    app.lifespan.update(
        {
            "page": page,
            "detail_page": detail_page,
            "browser": page.context,
            "cart": [],
            "valid_urls": set(),
            "page_context": app.PageContext.CART,
        },
    )

    # Clear any existing background tasks
    app.background_tasks.clear()

    # Create a mock Context that references the same lifespan dictionary
    ctx = MagicMock(spec=Context)
    # The app accesses ctx.request_context.lifespan_context
    ctx.request_context.lifespan_context = app.lifespan

    yield ctx

    # Cleanup background tasks
    tasks = list(app.background_tasks)
    for task in tasks:
        task.cancel()

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    # Cleanup detail page
    if not detail_page.is_closed():
        await detail_page.close()
