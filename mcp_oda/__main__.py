import argparse
import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from enum import Enum
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import Context, FastMCP
from playwright._impl._driver import compute_driver_executable, get_driver_env
from playwright.async_api import BrowserContext, Page, async_playwright

from mcp_oda import tools

logger = logging.getLogger(__name__)

lifespan = {}
background_tasks = set()


class PageContext(str, Enum):
    CART = "cart"
    PRODUCT_SEARCH = "product_search"
    RECIPE_SEARCH = "recipe_search"
    RECIPE_INFO = "recipe_info"


@asynccontextmanager
async def lifespan_context(*_args: object) -> AsyncIterator[dict[str, Any]]:
    yield lifespan


def _page(ctx: Context) -> Page:
    return ctx.request_context.lifespan_context["page"]


def _detail_page(ctx: Context) -> Page:
    return ctx.request_context.lifespan_context["detail_page"]


def _browser(ctx: Context) -> BrowserContext:
    return ctx.request_context.lifespan_context["browser"]


def _register_page_url(ctx: Context, url: str) -> None:
    valid_urls = ctx.request_context.lifespan_context.setdefault("valid_urls", set())
    if url:
        valid_urls.add(url)


async def _refresh_cart(ctx: Context) -> None:
    """Refreshes the cart state in the background."""
    browser = _browser(ctx)
    bg_page = await browser.new_page()
    try:
        cart_items = await tools.get_cart_contents(bg_page)
        ctx.request_context.lifespan_context["cart"] = cart_items
    finally:
        await bg_page.close()


def _fire_and_forget_refresh(ctx: Context) -> None:
    task = asyncio.create_task(_refresh_cart(ctx))
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


def _set_context(ctx: Context, context: PageContext) -> None:
    ctx.request_context.lifespan_context["page_context"] = context


def _assert_context(ctx: Context, expected: PageContext) -> None:
    current = ctx.request_context.lifespan_context.get("page_context")
    if current != expected:
        msg = (
            f"Invalid page context. Expected {expected.value}, but currently in {current}. "
            "Please navigate to the correct page first."
        )
        raise ValueError(msg)


def _determine_context_from_url(url: str) -> PageContext | None:
    if "/cart/" in url:
        return PageContext.CART
    if "/search/products/" in url:
        return PageContext.PRODUCT_SEARCH
    if "/recipes/all/" in url:
        return PageContext.RECIPE_SEARCH
    if "/recipes/" in url:
        return PageContext.RECIPE_INFO
    return None


mcp = FastMCP(
    "oda",
    instructions="""
    Provides an interface to the online grocery store Oda (formerly Kolonial.no).
    Use this server to search for products, navigate search results, manage the shopping cart, and inspect cart contents.

    IMPORTANT:
    - This server uses a persistent browser session.
    - The shopping cart is available as a resource at 'oda://cart'.
    - Always 'products_search' first to find products and get their 'index'.
    - Use 'cart_add_product' with the 'index' from the search results.
    - Use 'cart_get_contents' (tool) or 'oda://cart' (resource) to see what is in the cart.
    - Pagination tools ('products_search_next', 'products_search_previous') operate on the current search context.
    - For recipes: Search recipes -> Open recipe (get details) -> Add recipe to cart.
    """,
    lifespan=lifespan_context,
)


@mcp.resource(
    "oda://context",
    description="Returns the current context (cart, product_search, recipe_search, recipe_info).",
    mime_type="text/plain",
)
def context() -> str | None:
    return lifespan.get("page_context")


@mcp.resource(
    "oda://cart",
    description="Returns the current shopping cart contents",
    mime_type="application/json",
)
def cart() -> list[tools.CartItem]:
    return lifespan.get("cart", [])


@mcp.tool(
    description="List all items currently in the shopping cart, including their names, quantities, and removal 'index'.",
)
async def cart_get_contents(ctx: Context) -> list[tools.CartItem]:
    page = _page(ctx)
    cart_items = await tools.get_cart_contents(page)
    _set_context(ctx, PageContext.CART)
    ctx.request_context.lifespan_context["cart"] = cart_items
    return cart_items


@mcp.tool(
    description="Remove an item from the cart using its 'index' from the 'cart_get_contents' list. Requires context: 'cart'.",
)
async def cart_remove_item(ctx: Context, index: int) -> None:
    _assert_context(ctx, PageContext.CART)
    page = _page(ctx)
    success = await tools.remove_item_from_cart(page, index)
    if not success:
        msg = f"Failed to remove item at index {index} from cart."
        raise RuntimeError(msg)
    _fire_and_forget_refresh(ctx)


@mcp.tool(
    description="Navigate back to a previously visited URL (e.g., search results). The URL must have been previously returned by a search tool.",
)
async def go_back(ctx: Context, url: str) -> None:
    page = _page(ctx)
    valid_urls = ctx.request_context.lifespan_context.get("valid_urls", set())

    if url not in valid_urls:
        logger.warning("Attempted to navigate to untrusted URL: %s", url)
        msg = f"Untrusted URL: {url}. You can only navigate to URLs returned by search tools."
        raise ValueError(msg)

    try:
        await page.goto(url)
    except Exception as e:
        logger.warning("Failed to navigate to URL: %s", url, exc_info=True)
        msg = f"Failed to navigate to {url}: {e}"
        raise RuntimeError(msg) from e
    else:
        new_context = _determine_context_from_url(url)
        if new_context:
            _set_context(ctx, new_context)


@mcp.tool(
    description="Add a product to the cart using its 'index' from the *most recent* search result list (or pagination result). Requires context: 'product_search'.",
)
async def product_add_to_cart(ctx: Context, index: int) -> None:
    _assert_context(ctx, PageContext.PRODUCT_SEARCH)
    page = _page(ctx)
    success = await tools.add_search_result_to_cart(page, index)
    if not success:
        msg = f"Failed to add product at index {index} to cart."
        raise RuntimeError(msg)
    _fire_and_forget_refresh(ctx)


@mcp.tool(
    description="Search for products on Oda. Returns a list of products with their names, prices, and 'index'. The 'index' is required to add an item to the cart.",
)
async def products_search(ctx: Context, query: str) -> tools.ProductPage:
    page = _page(ctx)
    results = await tools.search_products(page, query)
    _register_page_url(ctx, results.page_url)
    _set_context(ctx, PageContext.PRODUCT_SEARCH)
    return results


@mcp.tool(
    description="Get the next page of search results. Returns a new list of products with indices. Fails if no search has been performed or if on the last page. Requires context: 'product_search'.",
)
async def products_search_next(ctx: Context) -> tools.ProductPage:
    _assert_context(ctx, PageContext.PRODUCT_SEARCH)
    page = _page(ctx)
    results = await tools.search_next_page(page)
    _register_page_url(ctx, results.page_url)
    return results


@mcp.tool(
    description="Open a recipe to get detailed information (ingredients, instructions, etc.).",
)
async def recipes_get_details(ctx: Context, index: int) -> tools.RecipeDetail:
    main_page = _page(ctx)
    detail_page = _detail_page(ctx)

    # 1. Get URL from main page (search results)
    url = await tools.get_recipe_url(main_page, index)
    if not url:
        msg = f"Could not resolve recipe index {index} to a URL"
        raise ValueError(msg)

    # 2. Navigate detail page to that URL
    await detail_page.goto(url)

    # 3. Scrape details from detail page
    result = await tools.scrape_recipe_details(detail_page)

    _set_context(ctx, PageContext.RECIPE_INFO)
    return result


@mcp.tool(
    description="Add ingredients for the current recipe to the cart. Provide the number of portions. Requires context: 'recipe_info'.",
)
async def recipe_add_to_cart(ctx: Context, portions: int) -> None:
    _assert_context(ctx, PageContext.RECIPE_INFO)
    detail_page = _detail_page(ctx)
    success = await tools.add_current_recipe_to_cart(detail_page, portions)
    if not success:
        msg = f"Failed to add recipe with {portions} portions to cart."
        raise RuntimeError(msg)
    _fire_and_forget_refresh(ctx)


@mcp.tool(
    description="Search for recipes on Oda. Returns filters and recipes with indices. Use 'index' to add a recipe.",
)
async def recipes_search(
    ctx: Context,
    query: str | None = None,
) -> tools.RecipePage:
    page = _page(ctx)
    results = await tools.search_recipes(page, query)
    _register_page_url(ctx, results.page_url)
    _set_context(ctx, PageContext.RECIPE_SEARCH)
    return results


@mcp.tool(
    description="Toggle filters on the recipe search page. Provide a list of filter IDs. Returns updated filters and recipes. Requires context: 'recipe_search'.",
)
async def recipes_search_filter(
    ctx: Context,
    filter_ids: list[str],
) -> tools.RecipePage:
    _assert_context(ctx, PageContext.RECIPE_SEARCH)
    page = _page(ctx)
    results = await tools.search_recipes_filter(page, filter_ids)
    _register_page_url(ctx, results.page_url)
    return results


@mcp.tool(
    description="Get the next page of recipe search results. Returns a list of recipes with indices. Requires context: 'recipe_search'.",
)
async def recipes_search_next(ctx: Context) -> tools.RecipePage:
    _assert_context(ctx, PageContext.RECIPE_SEARCH)
    page = _page(ctx)
    results = await tools.search_recipes_next(page)
    _register_page_url(ctx, results.page_url)
    return results


@asynccontextmanager
async def _create_browser(
    data_dir: Path,
    *,
    headless: bool = True,
) -> AsyncIterator[BrowserContext]:
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
        lifespan["browser"] = browser
        lifespan["page"] = browser.pages[0]
        # Create a persistent detail page
        lifespan["detail_page"] = await browser.new_page()
        lifespan["cart"] = []
        lifespan["valid_urls"] = set()
        lifespan["page_context"] = PageContext.CART

        # Initial navigation to cart and content refresh
        try:
            # Use the main page to fetch cart contents initially.
            # This navigates the main page to /cart/, establishing the context and getting data in one go.
            cart_items = await tools.get_cart_contents(lifespan["page"])
            lifespan["cart"] = cart_items
        except Exception as e:  # noqa: BLE001
            logger.warning(
                "Failed to perform initial cart setup: %s",
                e,
                exc_info=True,
            )

        try:
            await mcp.run_stdio_async()
        finally:
            await browser.close()


async def _auth(data_dir: Path) -> None:
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
        except (Exception, KeyboardInterrupt):  # noqa: BLE001
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
        default=os.environ.get("MCP_ODA_DATA_DIR", str(Path.home() / ".mcp-oda")),
        help="Directory for browser data (default: $HOME/.mcp-oda)",
    )

    # Create mutually exclusive group for auth and clean
    exclusive_group = parser.add_mutually_exclusive_group()
    exclusive_group.add_argument(
        "--auth",
        action="store_true",
        default=os.environ.get("MCP_ODA_AUTH", "").lower() in ("true", "1", "yes"),
        help="Run in auth mode to set up authentication",
    )
    exclusive_group.add_argument(
        "--clean",
        action="store_true",
        default=os.environ.get("MCP_ODA_CLEAN", "").lower() in ("true", "1", "yes"),
        help="Remove the data directory and exit",
    )

    parser.add_argument(
        "--headed",
        action="store_true",
        default=os.environ.get("MCP_ODA_HEADED", "").lower() in ("true", "1", "yes"),
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
