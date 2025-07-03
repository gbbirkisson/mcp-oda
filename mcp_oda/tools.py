import asyncio
import logging
from collections.abc import Coroutine
from dataclasses import dataclass
from typing import Any, TypeVar
from urllib.parse import urlencode

from playwright.async_api import Locator, Page, expect

logger = logging.getLogger(__name__)

T = TypeVar("T")


@dataclass
class SearchResult:
    index: int
    name: str
    subtitle: str
    price: float
    relative_price: float
    relative_price_unit: str


@dataclass
class CartItem:
    index: int
    name: str
    subtitle: str
    quantity: int
    price: float
    relative_price: float
    relative_price_unit: str


async def _suppress_error(c: Coroutine[Any, Any, T]) -> T | None:
    try:
        return await c
    except Exception:  # noqa: BLE001
        logger.debug("Suppressed error in coroutine", exc_info=True)
        return None


async def cart(page: Page) -> list[CartItem]:
    await page.goto("https://oda.com/no/cart/")
    await expect(page).to_have_title("Handlekurv – Oda")  # noqa: RUF001
    await asyncio.wait(
        [
            asyncio.create_task(
                _suppress_error(
                    page.locator(
                        'span:has-text("Sjekk handlekurven før du går til kassen og betaler.")',
                    ).wait_for(timeout=5000),
                ),
            ),
            asyncio.create_task(
                _suppress_error(
                    page.locator(
                        'span:has-text("Du har ingen varer i handlekurven.")',
                    ).wait_for(timeout=5000),
                ),
            ),
        ],
        timeout=5000,
        return_when=asyncio.FIRST_COMPLETED,
    )

    articles = await page.get_by_role("article").all()

    async def extract_cart_item(index: int, article: Locator) -> CartItem:
        # Extract all data in parallel
        name_task = article.locator("h1").text_content()
        subtitle_task = article.locator(".styles_ProductInfoText__bDdwb span").first.text_content()
        quantity_task = article.locator("input[data-testid='cart-buttons-quantity']").get_attribute("value")
        price_task = article.locator(".k-text--weight-bold").last.text_content()
        relative_price_task = article.locator(".k-text-color--subdued").last.text_content()

        # Wait for all extractions to complete
        name, subtitle, quantity_str, price, relative_price = await asyncio.gather(
            name_task, subtitle_task, quantity_task, price_task, relative_price_task,
        )

        # Parse quantity
        quantity = int(quantity_str) if quantity_str else 0

        # Parse price - remove 'kr', spaces, non-breaking spaces, and convert to float
        price_text = price.strip() if price else ""
        price_num = float(
            price_text.replace("kr", "")
            .replace("\xa0", "")
            .replace(" ", "")  # Remove regular spaces (thousands separator)
            .replace(",", ".")
            .strip(),
        )

        # Parse relative price and extract unit
        rel_price_text = relative_price.strip() if relative_price else ""
        rel_price_parts = (
            rel_price_text.replace("\xa0", " ").replace("\u2009", " ").split("/")
        )
        rel_price_num = float(
            rel_price_parts[0]
            .replace("kr", "")
            .replace("\xa0", "")
            .replace(" ", "")  # Remove regular spaces (thousands separator)
            .replace(",", ".")
            .strip(),
        )
        rel_price_unit = "/" + rel_price_parts[1] if len(rel_price_parts) > 1 else ""

        return CartItem(
            index=index,
            name=name.strip() if name else "",
            subtitle=subtitle.strip() if subtitle else "",
            quantity=quantity,
            price=price_num,
            relative_price=rel_price_num,
            relative_price_unit=rel_price_unit,
        )

    # Process all articles in parallel
    return await asyncio.gather(*[
        extract_cart_item(i, article) for i, article in enumerate(articles)
    ])


async def search(page: Page, query: str) -> list[SearchResult]:
    q = urlencode({"q": query})
    await page.goto(f"https://oda.com/no/search/products/?{q}")
    return await _search_results(page)


async def search_next(page: Page) -> list[SearchResult]:
    # Click next page button and wait for navigation
    await page.get_by_label("Neste side").click()
    # Wait for the new page to load
    await page.wait_for_load_state("networkidle")
    # Small delay to ensure DOM is updated
    await page.wait_for_timeout(500)
    return await _search_results(page)


async def search_prev(page: Page) -> list[SearchResult]:
    # Click previous page button and wait for navigation
    await page.get_by_label("Forrige side").click()
    # Wait for the new page to load
    await page.wait_for_load_state("networkidle")
    # Small delay to ensure DOM is updated
    await page.wait_for_timeout(500)
    return await _search_results(page)


async def _search_results(page: Page) -> list[SearchResult]:
    articles = await page.get_by_role("article").all()

    async def extract_search_result(index: int, article: Locator) -> SearchResult | None:
        try:
            # Extract all data in parallel
            name_task = article.locator("p.k-text-style--title-xxs").text_content()
            subtitle_task = article.locator("p.k-text-color--subdued").first.text_content()
            price_task = article.locator("span.k-text--weight-bold.k-text-color--default").text_content()
            rel_price_task = article.locator("p.k-text-color--subdued").last.text_content()

            # Wait for all extractions to complete
            name, subtitle, price_text, rel_price_text = await asyncio.gather(
                name_task, subtitle_task, price_task, rel_price_task,
            )

            # Parse prices
            price_clean = price_text or ""
            price_num = float(
                price_clean.replace("kr", "")
                .replace("\xa0", "")
                .replace(" ", "")  # Remove regular spaces (thousands separator)
                .replace(",", ".")
                .strip(),
            )

            rel_price_clean = rel_price_text or ""
            rel_price_parts = (
                rel_price_clean.replace("\xa0", " ").replace("\u2009", " ").split("/")
            )
            rel_price_num = float(
                rel_price_parts[0]
                .replace("kr", "")
                .replace("\xa0", "")
                .replace(" ", "")  # Remove regular spaces (thousands separator)
                .replace(",", ".")
                .strip(),
            )
            rel_price_unit = (
                "/" + rel_price_parts[1].strip() if len(rel_price_parts) > 1 else ""
            )

            return SearchResult(
                index=index,
                name=name.strip() if name else "",
                subtitle=subtitle.strip() if subtitle else "",
                price=price_num,
                relative_price=rel_price_num,
                relative_price_unit=rel_price_unit,
            )
        except Exception:  # noqa: BLE001
            # Skip articles that don't match expected structure
            logger.debug("Failed to extract search result at index %d", index, exc_info=True)
            return None

    # Process all articles in parallel
    results = await asyncio.gather(*[
        extract_search_result(i, article) for i, article in enumerate(articles)
    ])

    # Filter out None results (failed extractions)
    return [result for result in results if result is not None]


async def _modify_cart_item(page: Page, index: int, button_label: str) -> bool:
    """Generic function to add or remove items from cart."""
    articles = await page.get_by_role("article").all()
    if index >= len(articles):
        msg = f"Article index {index} out of range. Only {len(articles)} articles found."
        raise ValueError(msg)

    article = articles[index]

    # Scroll the article into view first
    await article.scroll_into_view_if_needed()

    # Find the button by label
    button = article.get_by_label(button_label)

    # Wait for button to be visible and enabled
    await button.wait_for(state="visible", timeout=5000)
    await expect(button).to_be_enabled()

    # Set up response listener before clicking
    async with page.expect_response(
        lambda response: "https://oda.com/tienda-web-api/v1/cart/items/" in response.url
        and response.status in [200, 201, 204],  # 204 for DELETE operations
        timeout=10000,
    ) as response_info:
        await button.click(force=False, timeout=5000)
        # Wait for the API response
        try:
            await response_info.value
            await page.wait_for_timeout(500)  # Small delay to ensure UI updates
        except Exception:
            action = "add to" if "Legg til" in button_label else "remove from"
            logger.exception("Failed to %s cart", action)
            return False
        else:
            return True


async def add_to_cart(page: Page, index: int) -> bool:
    """Add an item to the cart."""
    return await _modify_cart_item(page, index, "Legg til i handlekurven")


async def remove_from_cart(page: Page, index: int) -> bool:
    """Remove an item from the cart."""
    return await _modify_cart_item(page, index, "Fjern fra handlekurven")
