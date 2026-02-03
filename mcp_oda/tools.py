import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
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
class ProductPage:
    page_url: str
    items: list[SearchResult]


@dataclass
class CartItem:
    index: int
    name: str
    subtitle: str
    quantity: int
    price: float
    relative_price: float
    relative_price_unit: str


@dataclass
class Recipe:
    index: int
    name: str
    image_url: str | None = None
    duration: str | None = None
    difficulty: str | None = None


@dataclass
class RecipeFilter:
    id: str
    name: str
    count: int
    category: str


@dataclass
class RecipePage:
    page_url: str
    filters: list[RecipeFilter]
    items: list[Recipe]


@dataclass
class RecipeDetail:
    name: str
    description: str
    ingredients: list[str]
    instructions: list[str]
    image_url: str | None = None


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

    # Recipes
    RECIPE_GRID_LINK = 'a[href^="/no/recipes/"]'  # Generic link
    FILTER_NAV = 'nav[aria-label="Liste over filtre"]'
    FILTER_CATEGORY_CONTAINER = "div.k-py-2"
    FILTER_LABEL = "label"
    FILTER_CHECKBOX = "input[type='checkbox']"
    FILTER_NAME = "span.k-text-style--body-m"
    FILTER_COUNT = "span.k-pill"
    RECIPE_PORTIONS_SELECT = "label:has-text('Porsjoner') ~ button"
    RECIPE_ADD_TO_CART_BUTTON = "button[data-testid='add-to-cart-button']"


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
            done, pending = await asyncio.wait(
                tasks,
                timeout=2000,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in done:
                # Retrieve exception to avoid "exception never retrieved" warning
                with suppress(Exception):
                    task.result()

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
        name_task = article.locator(Selectors.CART_ITEM_NAME).text_content(
            timeout=timeout,
        )
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

    async def search_products(self, query: str) -> ProductPage:
        q = urlencode({"q": query})
        await self.page.goto(f"{self.BASE_URL}/search/products/?{q}")
        await self.page.wait_for_load_state("networkidle")
        return await self._scrape_search_results()

    async def search_next_page(self) -> ProductPage:
        return await self._navigate(
            Selectors.NEXT_PAGE,
            self._scrape_search_results,
            state_extractor=self._get_product_state,
        ) or ProductPage(self.page.url, [])

    async def search_previous_page(self) -> ProductPage:
        return await self._navigate(
            Selectors.PREV_PAGE,
            self._scrape_search_results,
            state_extractor=self._get_product_state,
        ) or ProductPage(self.page.url, [])

    async def search_recipes_next(self) -> RecipePage:
        return await self._navigate(
            Selectors.NEXT_PAGE,
            self._scrape_recipes_page,
            state_extractor=self._get_recipe_state,
        ) or RecipePage(self.page.url, [], [])

    async def search_recipes_previous(self) -> RecipePage:
        return await self._navigate(
            Selectors.PREV_PAGE,
            self._scrape_recipes_page,
            state_extractor=self._get_recipe_state,
        ) or RecipePage(self.page.url, [], [])

    async def _get_product_state(self) -> str:
        p = await self._scrape_search_results()
        return p.items[0].name if p.items else ""

    async def _get_recipe_state(self) -> str:
        p = await self._scrape_recipes_page()
        return p.items[0].name if p.items else ""

    async def _navigate(
        self,
        label: str,
        scraper_func: Callable[[], Awaitable[T]],
        state_extractor: Callable[[], Awaitable[str]] | None = None,
    ) -> T | None:
        try:
            button = self.page.get_by_label(label)
            if await button.is_visible():
                # Capture current state if extractor provided
                previous_state = ""
                if state_extractor:
                    with suppress(Exception):
                        previous_state = await state_extractor()

                current_url = self.page.url
                await button.click()

                # Wait for URL to change if applicable
                try:
                    await self.page.wait_for_url(
                        lambda u: str(u) != current_url,
                        timeout=5000,
                    )
                except Exception:  # noqa: BLE001
                    # URL might not change for some SPA actions, proceed to network idle
                    logger.debug("URL did not change after navigation click")

                await self.page.wait_for_load_state("networkidle")

                # If we have a state extractor, wait for change
                if state_extractor and previous_state:
                    try:
                        # Poll for state change
                        # We use a simple python loop with sleep, as we can't easily inject the full python logic into browser
                        start_time = asyncio.get_running_loop().time()
                        while (asyncio.get_running_loop().time() - start_time) < 5.0:
                            current_state = await state_extractor()
                            if current_state != previous_state:
                                break
                            await asyncio.sleep(0.2)
                        else:
                            logger.warning(
                                "Timed out waiting for state change after navigation.",
                            )
                    except Exception:  # noqa: BLE001
                        logger.warning(
                            "Error while waiting for content change",
                            exc_info=True,
                        )

                await self.page.wait_for_timeout(500)  # Grace period for DOM updates
                return await scraper_func()
        except Exception:  # noqa: BLE001
            logger.info("Navigation button '%s' not usable.", label)
        return None

    async def _scrape_search_results(self) -> ProductPage:
        try:
            items = await self.page.eval_on_selector_all(
                Selectors.SEARCH_ARTICLE,
                """(articles, selectors) => articles.map(article => {
                    const relPrices = article.querySelectorAll(selectors.rel_price);
                    return {
                        name: article.querySelector(selectors.name)?.innerText,
                        subtitle: article.querySelector(selectors.subtitle)?.innerText,
                        price: article.querySelector(selectors.price)?.innerText,
                        rel_price: relPrices.length > 0 ? relPrices[relPrices.length - 1].innerText : null
                    };
                })""",
                {
                    "name": Selectors.SEARCH_ITEM_NAME,
                    "subtitle": Selectors.SEARCH_ITEM_SUBTITLE,
                    "price": Selectors.SEARCH_ITEM_PRICE,
                    "rel_price": Selectors.SEARCH_ITEM_REL_PRICE,
                },
            )
        except Exception:  # noqa: BLE001
            logger.warning("Failed to batch scrape search results", exc_info=True)
            return ProductPage(page_url=self.page.url, items=[])

        results = []
        for i, item in enumerate(items):
            try:
                name = item.get("name")
                if not name:
                    continue

                subtitle = item.get("subtitle")
                price_str = item.get("price")
                rel_price_str = item.get("rel_price")

                price = Parsers.parse_price(price_str)
                rel_price, rel_unit = Parsers.parse_relative_price(rel_price_str)

                results.append(
                    SearchResult(
                        index=len(results),  # Use consecutive index for filtered list
                        name=name.strip(),
                        subtitle=subtitle.strip() if subtitle else "",
                        price=price,
                        relative_price=rel_price,
                        relative_price_unit=rel_unit,
                    ),
                )
            except Exception:  # noqa: BLE001
                logger.debug(
                    "Skipping article at index %s (parsing failed)",
                    i,
                    exc_info=True,
                )
        return ProductPage(page_url=self.page.url, items=results)

    # Remove _extract_search_result as it is no longer used
    # async def _extract_search_result...

    async def search_recipes(
        self,
        query: str | None = None,
    ) -> RecipePage:
        url = f"{self.BASE_URL}/recipes/all/"
        if query:
            q = urlencode({"q": query})
            url += f"?{q}"
        await self.page.goto(url)

        return await self._scrape_recipes_page()

    async def _scrape_recipes_page(self) -> RecipePage:
        filters = await self._scrape_recipe_filters()
        recipes = await self._scrape_recipes()
        return RecipePage(page_url=self.page.url, filters=filters, items=recipes)

    async def _scrape_recipe_filters(self) -> list[RecipeFilter]:
        filters = []
        nav = self.page.locator(Selectors.FILTER_NAV)
        if not await nav.is_visible():
            return []

        category_containers = await nav.locator(
            Selectors.FILTER_CATEGORY_CONTAINER,
        ).all()
        for container in category_containers:
            try:
                title_el = container.locator("span.k-text--weight-bold").first
                if not await title_el.is_visible():
                    continue
                category = await title_el.text_content()
                category = category.strip() if category else "Unknown"

                labels = await container.locator(Selectors.FILTER_LABEL).all()
                for label in labels:
                    try:
                        inp = label.locator(Selectors.FILTER_CHECKBOX)
                        # Use a short timeout to prevent stalling if element is not ready
                        id_attr = await inp.get_attribute("id", timeout=100)

                        name_el = label.locator(Selectors.FILTER_NAME)
                        name = await name_el.text_content(timeout=100)

                        count_el = label.locator(Selectors.FILTER_COUNT)
                        count_str = (
                            await count_el.text_content(timeout=100)
                            if await count_el.is_visible()
                            else "0"
                        )

                        filters.append(
                            RecipeFilter(
                                id=id_attr or "",
                                name=name.strip() if name else "",
                                count=int(count_str.strip()) if count_str else 0,
                                category=category,
                            ),
                        )
                    except Exception:  # noqa: BLE001
                        logger.debug("Skipping a filter label due to timeout/error")
            except Exception:  # noqa: BLE001
                logger.warning("Failed to parse a filter category", exc_info=True)

        return filters

    def _is_valid_recipe_url(self, url: str) -> bool:
        # Basic validation of URL structure
        # expected: /no/recipes/123-name/
        parts = url.strip("/").split("/")
        # Check if it looks like a recipe URL (has ID)
        # parts[-1] is the slug e.g. "608-oda-pizza-parma"

        if len(parts) < 3:
            return False

        # Filter out /no/recipes/provider/ID/ etc.
        # Strict recipe URL: /no/recipes/ID-SLUG/
        # so parts[-2] must be "recipes"
        if parts[-2] != "recipes":
            return False

        return parts[-1][0].isdigit()

    async def _scrape_recipes(self) -> list[Recipe]:
        recipes = []

        # Extract all data in one round trip
        try:
            items = await self.page.eval_on_selector_all(
                Selectors.RECIPE_GRID_LINK,
                """elements => elements.map(el => ({
                    url: el.getAttribute('href'),
                    text: el.innerText
                }))""",
            )
        except Exception:  # noqa: BLE001
            logger.warning("Failed to batch scrape recipes", exc_info=True)
            return []

        seen_urls = set()

        for item in items:
            url = item.get("url")
            if not url or url in seen_urls:
                continue

            if not self._is_valid_recipe_url(url):
                continue

            seen_urls.add(url)

            text = item.get("text")
            # Heuristic: split by newline, take first non-empty
            lines = [line.strip() for line in (text or "").split("\n") if line.strip()]
            name = lines[0] if lines else "Unknown Recipe"

            recipes.append(Recipe(index=len(recipes), name=name))

        return recipes

    async def search_recipes_filter(
        self,
        filter_ids: list[str],
    ) -> RecipePage:
        for fid in filter_ids:
            try:
                # Use verify visible to ensure we are on a page with filters
                loc = self.page.locator(f"input[id='{fid}']")
                if await loc.is_visible():
                    await loc.click()
                    # Wait for network idle or some update
                    await self.page.wait_for_load_state("networkidle")
                    await self.page.wait_for_timeout(500)  # Grace period
                else:
                    logger.warning("Filter %s not found on current page.", fid)
            except Exception:  # noqa: BLE001
                logger.warning("Failed to toggle filter %s", fid, exc_info=True)

        return await self._scrape_recipes_page()

    async def get_recipe_url(self, index: int) -> str | None:
        links = await self.page.locator(Selectors.RECIPE_GRID_LINK).all()
        seen_urls = set()
        valid_count = 0
        target_url = None

        for link in links:
            url = await link.get_attribute("href")
            if not url or url in seen_urls:
                continue

            if not self._is_valid_recipe_url(url):
                continue

            if valid_count == index:
                target_url = url
                break

            seen_urls.add(url)
            valid_count += 1

        if target_url:
            return f"{self.BASE_URL.replace('/no', '')}{target_url}"
        return None

    async def open_recipe_by_index(self, index: int) -> RecipeDetail:
        full_url = await self.get_recipe_url(index)
        if not full_url:
            msg = f"Could not resolve recipe index {index} to a URL"
            raise ValueError(msg)

        await self.page.goto(full_url)
        return await self._parse_recipe_json_ld()

    async def scrape_recipe_details(self) -> RecipeDetail:
        return await self._parse_recipe_json_ld()

    async def _parse_recipe_json_ld(self) -> RecipeDetail:
        json_ld_scripts = await self.page.locator(
            'script[type="application/ld+json"]',
        ).all()

        recipe_data: dict[str, Any] = {}
        for script in json_ld_scripts:
            content = await script.text_content()
            if not content:
                continue
            with suppress(json.JSONDecodeError):
                data = json.loads(content)
                found = self._find_recipe_in_json_ld(data)
                if found:
                    recipe_data = found
                    break

        if not recipe_data:
            msg = "Could not find Recipe JSON-LD data on page"
            raise ValueError(msg)

        return self._create_recipe_detail(recipe_data)

    def _find_recipe_in_json_ld(self, data: Any) -> dict[str, Any] | None:  # noqa: ANN401
        if isinstance(data, dict) and data.get("@type") == "Recipe":
            return data
        if isinstance(data, dict) and "@graph" in data:
            for item in data["@graph"]:
                if item.get("@type") == "Recipe":
                    return item
        return None

    def _create_recipe_detail(self, recipe_data: dict[str, Any]) -> RecipeDetail:
        image = recipe_data.get("image")
        image_url: str | None = None
        if isinstance(image, list) and image:
            first_image = image[0]
            if isinstance(first_image, str):
                image_url = first_image
        elif isinstance(image, str):
            image_url = image

        return RecipeDetail(
            name=str(recipe_data.get("name", "Unknown")),
            description=str(recipe_data.get("description", "")),
            ingredients=[str(i) for i in recipe_data.get("recipeIngredient", [])],
            instructions=[
                step.get("text", "") if isinstance(step, dict) else str(step)
                for step in recipe_data.get("recipeInstructions", [])
            ],
            image_url=image_url,
        )

    async def add_recipe_by_index(self, index: int, portions: int) -> bool:
        links = await self.page.locator(Selectors.RECIPE_GRID_LINK).all()
        seen_urls = set()
        valid_count = 0
        target_url = None

        for link in links:
            url = await link.get_attribute("href")
            if not url or url in seen_urls:
                continue

            if not self._is_valid_recipe_url(url):
                continue

            if valid_count == index:
                target_url = url
                break

            seen_urls.add(url)
            valid_count += 1

        if not target_url:
            logger.warning("Could not resolve recipe index %s to a URL", index)
            return False

        full_url = f"{self.BASE_URL.replace('/no', '')}{target_url}"
        await self.page.goto(full_url)
        return await self.add_current_recipe(portions)

    async def add_current_recipe(self, portions: int) -> bool:
        try:
            # Check if we landed on a recipe page (look for portions selector)
            portions_selector = self.page.locator(Selectors.RECIPE_PORTIONS_SELECT)
            await expect(portions_selector).to_be_visible(timeout=5000)
        except Exception:  # noqa: BLE001
            logger.warning(
                "Could not verify recipe page loaded (portions selector missing) at %s",
                self.page.url,
            )
            return False

        # Set portions
        try:
            # The selector targets the button that opens the dropdown
            # Get the ID of the menu it controls
            menu_id = await portions_selector.get_attribute("aria-controls")

            await portions_selector.click()

            option = None
            if menu_id:
                # Scope to the menu
                try:
                    menu = self.page.locator(f"#{menu_id}")
                    await expect(menu).to_be_visible(timeout=2000)
                    potential_option = menu.get_by_text(str(portions), exact=True)
                    # Quickly verify visibility to ensure we found the right element
                    await expect(potential_option).to_be_visible(timeout=1000)
                    option = potential_option
                except Exception:  # noqa: BLE001
                    logger.debug("Failed to find option via menu ID, falling back")
                    option = None

            if not option:
                # Fallback: simple text match if ID extraction fails or menu not found
                option = (
                    self.page.get_by_text(str(portions), exact=True)
                    .locator(
                        "visible=true",
                    )
                    .last
                )

            await expect(option).to_be_visible(timeout=3000)
            # Use force=True to bypass overlay interception if necessary
            await option.click(force=True)
            await self.page.wait_for_timeout(100)  # Wait for update
        except Exception:  # noqa: BLE001
            logger.warning("Failed to set portions to %s", portions, exc_info=True)
            return False

        # Click add to cart
        try:
            add_button = self.page.locator(Selectors.RECIPE_ADD_TO_CART_BUTTON)
            await expect(add_button).to_be_enabled()

            async with self.page.expect_response(
                lambda r: self.API_CART_URL_PART in r.url
                and r.status in [200, 201, 204],
                timeout=5000,
            ) as response_info:
                await add_button.click()
                await response_info.value

        except Exception:
            logger.exception("Failed to add recipe to cart")
            return False
        else:
            return True

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


async def search_products(page: Page, query: str) -> ProductPage:
    return await OdaClient(page).search_products(query)


async def search_next_page(page: Page) -> ProductPage:
    return await OdaClient(page).search_next_page() or ProductPage(page.url, [])


async def search_previous_page(page: Page) -> ProductPage:
    return await OdaClient(page).search_previous_page() or ProductPage(page.url, [])


async def add_search_result_to_cart(page: Page, index: int) -> bool:
    return await OdaClient(page).add_to_cart(index)


async def remove_item_from_cart(page: Page, index: int) -> bool:
    return await OdaClient(page).remove_from_cart(index)


async def search_recipes(
    page: Page,
    query: str | None = None,
) -> RecipePage:
    return await OdaClient(page).search_recipes(query)


async def search_recipes_next(page: Page) -> RecipePage:
    return await OdaClient(page).search_recipes_next() or RecipePage(
        page.url,
        [],
        [],
    )


async def search_recipes_previous(page: Page) -> RecipePage:
    return await OdaClient(page).search_recipes_previous() or RecipePage(
        page.url,
        [],
        [],
    )


async def search_recipes_filter(
    page: Page,
    filter_ids: list[str],
) -> RecipePage:
    return await OdaClient(page).search_recipes_filter(filter_ids)


async def open_recipe(page: Page, index: int) -> RecipeDetail:
    return await OdaClient(page).open_recipe_by_index(index)


async def get_recipe_url(page: Page, index: int) -> str | None:
    return await OdaClient(page).get_recipe_url(index)


async def scrape_recipe_details(page: Page) -> RecipeDetail:
    return await OdaClient(page).scrape_recipe_details()


async def add_recipe(page: Page, index: int, portions: int) -> bool:
    return await OdaClient(page).add_recipe_by_index(index, portions)


async def add_current_recipe_to_cart(page: Page, portions: int) -> bool:
    return await OdaClient(page).add_current_recipe(portions)
