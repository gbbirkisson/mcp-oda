import pytest
from mcp.server.fastmcp import Context

from mcp_oda.__main__ import recipes_search, recipes_search_next
from mcp_oda.tools import Recipe


@pytest.mark.asyncio
async def test_recipe_pagination(mcp_context: Context) -> None:
    # "Kylling" (Chicken) usually has many recipes
    result_p1 = await recipes_search(mcp_context, "Kylling")
    recipes_p1 = result_p1.items
    assert len(recipes_p1) > 0, "Should find some chicken recipes"

    # Try to go to next page
    result_p2 = await recipes_search_next(mcp_context)
    recipes_p2 = result_p2.items

    assert len(recipes_p2) > 0
    assert recipes_p1 != recipes_p2

    # Verify type
    assert isinstance(recipes_p2[0], Recipe)
