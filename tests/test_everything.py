from playwright.async_api import Page

from mcp_oda.tools import add_to_cart, cart, remove_from_cart, search, search_next


async def test_cart(page: Page) -> None:
    res = await cart(page)
    assert len(res) == 0
    products = await search(page, "club mate original")
    assert len(products) > 0
    await add_to_cart(page, products[0].index)
    res = await cart(page)
    assert len(res) == 1
    assert res[0].name == "Club-Mate Original"
    await remove_from_cart(page, res[0].index)
    res = await cart(page)
    assert len(res) == 0


async def test_pagination(page: Page) -> None:
    p1 = await search(page, "melk")
    assert len(p1) > 0
    p2 = await search_next(page)
    assert len(p2) > 0
    assert p1 != p2
