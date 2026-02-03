from mcp.server.fastmcp import Context
from playwright.async_api import Page

from mcp_oda.__main__ import (
    cart_get_contents,
    cart_remove_item,
    product_add_to_cart,
    products_search,
    products_search_next,
)


async def test_search_and_add_to_cart(page: Page, mcp_context: Context) -> None:
    # Ensure we are on the site
    await page.goto("https://oda.com/no/")

    # Check initial cart state (might be empty)
    res = await cart_get_contents(mcp_context)
    # If we are not logged in, cart might be empty.
    # We clear it if it's not? Or assume it's empty for test.
    # Since we can't easily clear without knowing what's in it, we assume 0 or handle cleanup later.
    # For a clean test run, we usually expect 0.

    # If the previous test run failed, we might have items.
    # Let's try to remove everything if any?
    # That requires complex logic. Let's assume clean session (incognito).
    assert len(res) == 0

    # Search
    page_result = await products_search(mcp_context, "club mate original")
    assert len(page_result.items) > 0
    # Items no longer have URL, but page does
    assert page_result.page_url.startswith("https://oda.com")

    # Add to cart
    # Note: This might require login on the real site.
    # If it fails/redirects to login, the test will fail.
    # We proceed assuming anonymous cart is possible or environment is set up.
    await product_add_to_cart(mcp_context, page_result.items[0].index)

    # Verify add
    res = await cart_get_contents(mcp_context)
    assert len(res) == 1
    # Flexible match in case of formatting differences
    assert "Club-Mate" in res[0].name

    # Remove
    await cart_remove_item(mcp_context, res[0].index)

    # Verify remove
    res = await cart_get_contents(mcp_context)
    assert len(res) == 0


async def test_search_and_pagination(mcp_context: Context) -> None:
    p1 = await products_search(mcp_context, "melk")
    assert len(p1.items) > 0
    p2 = await products_search_next(mcp_context)
    assert len(p2.items) > 0
    assert p1.items != p2.items
