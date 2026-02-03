import asyncio
import logging
from contextlib import suppress
from dataclasses import dataclass
from urllib.parse import urlencode

from playwright.async_api import Locator, Page, expect

logger = logging.getLogger(__name__)


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


class Parsers:
    @staticmethod
    def parse_price(text: str | None) -> float:
        if not text:
            return 0.0
        try:
            # Remove currency, non-breaking spaces, regular spaces (thousands separator)
            clean_text = (
                text.replace("kr", "")
                .replace("\xa0", "")
                .replace(" ", "")
                .replace(",", ".")
                .strip()
            )
            return float(clean_text)
        except ValueError:
            logger.debug("Failed to parse price: %s", text)
            return 0.0

    @staticmethod
    def parse_relative_price(text: str | None) -> tuple[float, str]:
        if not text:
            return 0.0, ""
        try:
            # Format usually: "61,80 kr /l" or similar
            parts = text.replace("\xa0", " ").replace("\u2009", " ").split("/")
            price_part = parts[0]
            unit_part = "/" + parts[1].strip() if len(parts) > 1 else ""
            return Parsers.parse_price(price_part), unit_part
        except (ValueError, IndexError):
            logger.debug("Failed to parse relative price: %s", text)
            return 0.0, ""


class Selectors:
    # Cart
    CART_TITLE = "Handlekurv – Oda"  # noqa: RUF001
    CART_EMPTY_MSG = 'span:has-text("Du har ingen varer i handlekurven.")'
    CART_CHECK_MSG = (
        'span:has-text("Sjekk handlekurven før du går til kassen og betaler.")'
    )
    CART_ARTICLE = "article"  # Using generic article role/tag
    CART_ITEM_NAME = "h1"
    CART_ITEM_SUBTITLE = ".styles_ProductInfoText__bDdwb span"
    CART_ITEM_QUANTITY = "input[data-testid='cart-buttons-quantity']"
    CART_ITEM_PRICE = ".k-text--weight-bold"  # Last one usually
    CART_ITEM_REL_PRICE = ".k-text-color--subdued"  # Last one usually

    # Search
    SEARCH_ARTICLE = "article"
    SEARCH_ITEM_NAME = "p.k-text-style--title-xxs"
    SEARCH_ITEM_SUBTITLE = "p.k-text-color--subdued"  # First one
    SEARCH_ITEM_PRICE = "span.k-text--weight-bold.k-text-color--default"
    SEARCH_ITEM_REL_PRICE = "p.k-text-color--subdued"  # Last one

    # Navigation
    NEXT_PAGE = "Neste side"  # Label
    PREV_PAGE = "Forrige side"  # Label

    # Actions
    ADD_TO_CART_LABEL = "Legg til i handlekurven"
    REMOVE_FROM_CART_LABEL = "Fjern fra handlekurven"


class OdaClient:
    """Encapsulates interaction with the Oda website."""

    BASE_URL = "https://oda.com/no"
    API_CART_URL_PART = "tienda-web-api/v1/cart/items/"

    def __init__(self, page: Page) -> None:
        self.page = page

    async def get_cart_contents(self) -> list[CartItem]:
        await self.page.goto(f"{self.BASE_URL}/cart/")
        await expect(self.page).to_have_title(Selectors.CART_TITLE)

        # Wait for either cart items or empty/info message to ensure page load
        tasks = [
            asyncio.create_task(
                self.page.get_by_text(
                    "Sjekk handlekurven før du går til kassen og betaler.",
                ).wait_for(timeout=1000),
            ),
            asyncio.create_task(
                self.page.get_by_text(
                    "Du har ingen varer i handlekurven.",
                ).wait_for(timeout=1000),
            ),
            asyncio.create_task(
                self.page.get_by_role("article").first.wait_for(timeout=1000),
            ),
        ]
        try:
            _, pending = await asyncio.wait(
                tasks,
                timeout=2000,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await task
        except Exception:  # noqa: BLE001
            logger.debug(
                "Timeout waiting for cart state, proceeding to scrape what's available.",
            )

        articles = await self.page.get_by_role("article").all()
        return await asyncio.gather(
            *[
                self._extract_cart_item(i, article)
                for i, article in enumerate(articles)
            ],
        )

    async def _extract_cart_item(self, index: int, article: Locator) -> CartItem:
        # Use short timeout as article is already visible
        timeout = 2000
        name_task = article.locator(Selectors.CART_ITEM_NAME).text_content(timeout=timeout)
        subtitle_task = self._safe_text(
            article.locator(Selectors.CART_ITEM_SUBTITLE).first,
            timeout_ms=timeout,
        )
        quantity_task = article.get_by_test_id("cart-buttons-quantity").get_attribute(
            "value",
            timeout=timeout,
        )
        price_task = article.locator(Selectors.CART_ITEM_PRICE).last.text_content(
            timeout=timeout,
        )
        rel_price_task = article.locator(
            Selectors.CART_ITEM_REL_PRICE,
        ).last.text_content(timeout=timeout)

        name, subtitle, quantity_str, price_str, rel_price_str = await asyncio.gather(
            name_task,
            subtitle_task,
            quantity_task,
            price_task,
            rel_price_task,
        )

        quantity = int(quantity_str) if quantity_str else 0
        price = Parsers.parse_price(price_str)
        rel_price, rel_unit = Parsers.parse_relative_price(rel_price_str)

        return CartItem(
            index=index,
            name=name.strip() if name else "Unknown Product",
            subtitle=subtitle.strip() if subtitle else "",
            quantity=quantity,
            price=price,
            relative_price=rel_price,
            relative_price_unit=rel_unit,
        )

    async def search_products(self, query: str) -> list[SearchResult]:
        q = urlencode({"q": query})
        await self.page.goto(f"{self.BASE_URL}/search/products/?{q}")
        return await self._scrape_search_results()

    async def search_next_page(self) -> list[SearchResult]:
        return await self._navigate_search(Selectors.NEXT_PAGE)

    async def search_previous_page(self) -> list[SearchResult]:
        return await self._navigate_search(Selectors.PREV_PAGE)

    async def _navigate_search(self, label: str) -> list[SearchResult]:
        try:
            button = self.page.get_by_label(label)
            if await button.is_visible():
                await button.click()
                await self.page.wait_for_load_state("networkidle")
                await self.page.wait_for_timeout(100)  # Grace period for DOM updates
                return await self._scrape_search_results()
        except Exception:  # noqa: BLE001
            logger.info("Navigation button '%s' not usable.", label)
        return []

    async def _scrape_search_results(self) -> list[SearchResult]:
        articles = await self.page.get_by_role("article").all()
        results = await asyncio.gather(
            *[
                self._extract_search_result(i, article)
                for i, article in enumerate(articles)
            ],
        )
        return [r for r in results if r is not None]

    async def _extract_search_result(
        self,
        index: int,
        article: Locator,
    ) -> SearchResult | None:
        try:
            name_task = article.locator(Selectors.SEARCH_ITEM_NAME).text_content()
            subtitle_task = article.locator(
                Selectors.SEARCH_ITEM_SUBTITLE,
            ).first.text_content()
            price_task = article.locator(Selectors.SEARCH_ITEM_PRICE).text_content()
            rel_price_task = article.locator(
                Selectors.SEARCH_ITEM_REL_PRICE,
            ).last.text_content()

            name, subtitle, price_str, rel_price_str = await asyncio.gather(
                name_task,
                subtitle_task,
                price_task,
                rel_price_task,
            )

            price = Parsers.parse_price(price_str)
            rel_price, rel_unit = Parsers.parse_relative_price(rel_price_str)

            return SearchResult(
                index=index,
                name=name.strip() if name else "Unknown Product",
                subtitle=subtitle.strip() if subtitle else "",
                price=price,
                relative_price=rel_price,
                relative_price_unit=rel_unit,
            )
        except Exception:  # noqa: BLE001
            logger.debug(
                "Skipping article at index %s (parsing failed)",
                index,
                exc_info=True,
            )
            return None

    async def add_to_cart(self, index: int) -> bool:
        return await self._modify_cart(index, Selectors.ADD_TO_CART_LABEL)

    async def remove_from_cart(self, index: int) -> bool:
        return await self._modify_cart(index, Selectors.REMOVE_FROM_CART_LABEL)

    async def _modify_cart(self, index: int, label: str) -> bool:
        articles = await self.page.get_by_role("article").all()
        if index >= len(articles):
            logger.warning(
                "Index %s out of bounds (found %s articles)",
                index,
                len(articles),
            )
            return False

        article = articles[index]
        await article.scroll_into_view_if_needed()
        button = article.get_by_label(label)

        try:
            await button.wait_for(state="visible", timeout=1000)
            await expect(button).to_be_enabled()
        except Exception:  # noqa: BLE001
            logger.warning("Button '%s' unavailable for item %s", label, index)
            return False

        async with self.page.expect_response(
            lambda r: self.API_CART_URL_PART in r.url and r.status in [200, 201, 204],
            timeout=2000,
        ) as response_info:
            await button.click()
            try:
                await response_info.value
                await self.page.wait_for_timeout(100)  # UI update grace period
            except Exception:
                logger.exception("API interaction failed for '%s'", label)
                return False
        return True

    async def _safe_text(self, locator: Locator, timeout_ms: float = 30000) -> str:
        try:
            return await locator.text_content(timeout=timeout_ms) or ""
        except Exception:  # noqa: BLE001
            return ""


# --- Tool Entry Points ---


async def get_cart_contents(page: Page) -> list[CartItem]:
    return await OdaClient(page).get_cart_contents()


async def search_products(page: Page, query: str) -> list[SearchResult]:
    return await OdaClient(page).search_products(query)


async def search_next_page(page: Page) -> list[SearchResult]:
    return await OdaClient(page).search_next_page()


async def search_previous_page(page: Page) -> list[SearchResult]:
    return await OdaClient(page).search_previous_page()


async def add_search_result_to_cart(page: Page, index: int) -> bool:
    return await OdaClient(page).add_to_cart(index)


async def remove_item_from_cart(page: Page, index: int) -> bool:
    return await OdaClient(page).remove_from_cart(index)
