import pytest
from mcp.server.fastmcp import Context

from mcp_oda.__main__ import cart, context, go_back, products_search
from mcp_oda.tools import CartItem


async def test_resources(mcp_context: Context) -> None:
    # Ensure fixture is used
    assert mcp_context

    # Test context resource
    # Should start in cart context (default)
    initial_context = context()
    assert initial_context == "cart"

    # Test cart resource
    cart_contents = cart()
    assert isinstance(cart_contents, list)
    # It might be empty initially
    if cart_contents:
        assert isinstance(cart_contents[0], CartItem)


async def test_go_back(mcp_context: Context) -> None:
    # Perform a search to get a valid URL
    search_result = await products_search(mcp_context, "brød")
    assert search_result.page_url
    assert len(search_result.items) > 0

    # Navigate to that URL using go_back
    await go_back(mcp_context, search_result.page_url)

    # Verify context updated (though product search stays product search)
    current_ctx = context()
    assert current_ctx == "product_search"

    # Try invalid URL (not in valid_urls)
    with pytest.raises(ValueError, match="Untrusted URL"):
        await go_back(mcp_context, "https://example.com")
