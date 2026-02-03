from playwright.async_api import Page

from mcp_oda.tools import (
    add_search_result_to_cart,
    get_cart_contents,
    remove_item_from_cart,
    search_next_page,
    search_products,
)


async def test_cart(page: Page) -> None:
    # Ensure we are on the site
    await page.goto("https://oda.com/no/")

    # Check initial cart state (might be empty)
    res = await get_cart_contents(page)
    # If we are not logged in, cart might be empty.
    # We clear it if it's not? Or assume it's empty for test.
    # Since we can't easily clear without knowing what's in it, we assume 0 or handle cleanup later.
    # For a clean test run, we usually expect 0.

    # If the previous test run failed, we might have items.
    # Let's try to remove everything if any?
    # That requires complex logic. Let's assume clean session (incognito).
    assert len(res) == 0

    # Search
    products = await search_products(page, "club mate original")
    assert len(products) > 0

    # Add to cart
    # Note: This might require login on the real site.
    # If it fails/redirects to login, the test will fail.
    # We proceed assuming anonymous cart is possible or environment is set up.
    await add_search_result_to_cart(page, products[0].index)

    # Verify add
    res = await get_cart_contents(page)
    assert len(res) == 1
    # Flexible match in case of formatting differences
    assert "Club-Mate" in res[0].name

    # Remove
    await remove_item_from_cart(page, res[0].index)

    # Verify remove
    res = await get_cart_contents(page)
    assert len(res) == 0


async def test_pagination(page: Page) -> None:
    p1 = await search_products(page, "melk")
    assert len(p1) > 0
    p2 = await search_next_page(page)
    assert len(p2) > 0
    assert p1 != p2
