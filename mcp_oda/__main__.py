import argparse
import asyncio
import json
import logging
import shutil
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from playwright.async_api import BrowserContext, Page, async_playwright

from mcp_oda import tools

logger = logging.getLogger(__name__)

lifespan = {}


@asynccontextmanager
async def lifespan_context(*_args: object) -> AsyncIterator[dict[str, Any]]:
    yield lifespan


def _page(ctx: Context) -> Page:
    return ctx.request_context.lifespan_context["page"]


mcp = FastMCP(
    "oda",
    instructions="Provides an interface to the online grocery store Oda. You can help with grocery shopping using this.",
    lifespan=lifespan_context,
)


@mcp.tool(
    description="Open search page for any product. Some searches might give better results in norwegian, e.g. melk instead of milk.",
)
async def search(ctx: Context, query: str) -> list[tools.SearchResult]:
    page = _page(ctx)
    return await tools.search(page, query)


@mcp.tool(
    description="Can only be used when searching, this will give you the next page of results.",
)
async def search_next(ctx: Context) -> list[tools.SearchResult]:
    page = _page(ctx)
    return await tools.search_next(page)


@mcp.tool(description="Open up cart page and list items currently in the cart.")
async def cart(ctx: Context) -> list[tools.CartItem]:
    page = _page(ctx)
    return await tools.cart(page)


@mcp.tool(description="Add item on current page to cart.")
async def add_to_cart(ctx: Context, index: int) -> bool:
    page = _page(ctx)
    return await tools.add_to_cart(page, index)


@mcp.tool(description="Remove item from cart.")
async def remove_from_cart(ctx: Context, index: int) -> bool:
    page = _page(ctx)
    return await tools.remove_from_cart(page, index)


@asynccontextmanager
async def _create_browser(data_dir: Path, *, headless: bool = True) -> AsyncIterator[BrowserContext]:
    async with async_playwright() as p:
        browser = await p.chromium.launch_persistent_context(
            data_dir,
            headless=headless,
        )

        cookies = data_dir / "cookies.json"
        if cookies.is_file():
            with cookies.open("r") as f:
                await browser.add_cookies(json.loads(f.read()))

        yield browser


async def _run(data_dir: Path, *, headless: bool = True) -> None:
    async with _create_browser(data_dir, headless=headless) as browser:
        lifespan["page"] = browser.pages[0]
        try:
            await mcp.run_stdio_async()
        finally:
            await browser.close()


async def _auth(data_dir: Path) -> None:
    from playwright._impl._driver import compute_driver_executable, get_driver_env

    driver_executable, driver_cli = compute_driver_executable()
    # Use asyncio.to_thread for blocking subprocess call
    completed_process = await asyncio.to_thread(
        subprocess.run,
        [driver_executable, driver_cli, "install", "chromium"],
        env=get_driver_env(),
        check=True,
    )
    if completed_process.returncode != 0:
        msg = "Failed to ensure that chromium was installed"
        raise RuntimeError(msg)

    sys.stdout.write("Opening browser for authentication...\n")
    sys.stdout.write("Please log in to your Oda account.\n")
    sys.stdout.write("Close the browser window when you're done logging in.\n")
    sys.stdout.flush()

    async with _create_browser(data_dir, headless=False) as browser:
        page = browser.pages[0]
        await page.goto("https://oda.com/no/account/")

        try:
            # Wait for the browser/page to be closed by the user
            await page.wait_for_event("close", timeout=0)  # No timeout
        except (Exception, KeyboardInterrupt):
            # Browser was closed or interrupted
            logger.debug("Browser closed or interrupted")
        finally:
            # Save cookies before closing
            try:
                sys.stdout.write("Saving session...\n")
                sys.stdout.flush()
                cookies = data_dir / "cookies.json"
                with cookies.open("w") as f:
                    f.write(json.dumps(await browser.cookies()))
                sys.stdout.write("Authentication completed. Session saved.\n")
                sys.stdout.flush()
            except (Exception, KeyboardInterrupt) as e:
                # Browser might already be closed
                logger.exception("Session save error")
                sys.stdout.write(f"Session saved with possible errors: {e}\n")
                sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description="MCP server for Oda grocery store")
    parser.add_argument(
        "--data-dir",
        type=str,
        default=str(Path.home() / ".mcp-oda"),
        help="Directory for browser data (default: $HOME/.oda_mcp)",
    )

    # Create mutually exclusive group for auth and clean
    exclusive_group = parser.add_mutually_exclusive_group()
    exclusive_group.add_argument(
        "--auth",
        action="store_true",
        help="Run in auth mode to set up authentication",
    )
    exclusive_group.add_argument(
        "--clean",
        action="store_true",
        help="Remove the data directory and exit",
    )

    parser.add_argument(
        "--headed",
        action="store_true",
        help="Run browser in headed mode (visible window)",
    )

    args = parser.parse_args()
    data_dir = Path(args.data_dir)

    if args.clean:
        if data_dir.exists():
            shutil.rmtree(data_dir)
            sys.stdout.write(f"Removed data directory: {data_dir}\n")
        else:
            sys.stdout.write(f"Data directory does not exist: {data_dir}\n")
        sys.stdout.flush()
        return

    # Create data directory if it doesn't exist
    data_dir.mkdir(parents=True, exist_ok=True)

    if args.auth:
        asyncio.run(_auth(data_dir))
    else:
        asyncio.run(_run(data_dir, headless=not args.headed))
