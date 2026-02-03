from mcp.server.fastmcp import Context

from mcp_oda.__main__ import (
    _page,
    cart_get_contents,
    recipe_add_to_cart,
    recipes_get_details,
    recipes_search,
    recipes_search_filter,
)


async def test_recipe_search_and_open(mcp_context: Context) -> None:
    # Search
    result = await recipes_search(mcp_context, "pizza")
    recipes = result.items
    filters = result.filters
    assert len(recipes) > 0, "Should find some pizza recipes"

    # Check filter structure - filters might be empty depending on query results
    # but for 'pizza' we expect some categories like 'Middag' etc.
    if filters:
        first_filter = filters[0]
        assert first_filter.id
        assert first_filter.name

    # Open recipe by index
    details = await recipes_get_details(mcp_context, recipes[0].index)
    assert details.name
    assert len(details.ingredients) > 0
    assert len(details.instructions) > 0


async def test_recipe_filtering(mcp_context: Context) -> None:
    result_before = await recipes_search(mcp_context, "pizza")
    filters = result_before.filters

    if not filters:
        # If no filters, skip filtering test
        return

    # Pick a filter, e.g. first one that has a count > 0 if possible
    target_filter = next((f for f in filters if f.count > 0), filters[0])

    updated_result = await recipes_search_filter(
        mcp_context,
        [target_filter.id],
    )

    assert updated_result.filters is not None
    assert updated_result.items is not None


async def test_recipe_add_to_cart(mcp_context: Context) -> None:
    # 1. Search to find a valid ID
    result = await recipes_search(mcp_context, "pizza")
    recipes = result.items
    assert len(recipes) > 0

    # Recipe should have index
    assert recipes[0].index == 0

    # 2. Open recipe to get details and set context to RECIPE_INFO
    # This navigates to the recipe page
    recipe_details = await recipes_get_details(mcp_context, 0)
    assert len(recipe_details.ingredients) > 0

    # 3. Add to cart (now requires RECIPE_INFO context)
    # We use a distinct portion count to verify if possible, but boolean return is enough for basic test
    await recipe_add_to_cart(mcp_context, 4)

    # Wait a bit for server-side processing if any (though we wait for response in tool)
    await _page(mcp_context).wait_for_timeout(2000)

    # 4. Open cart and verify ingredients
    cart_items = await cart_get_contents(mcp_context)
    assert len(cart_items) > 0

    # Verify that at least some ingredients are in the cart.
    # Matching can be tricky (recipe: "400g kjøttdeig", cart: "Kjøttdeig av storfe"),
    # so we look for partial string matches.
    cart_item_names = [item.name.lower() for item in cart_items]
    recipe_ingredients = [ing.lower() for ing in recipe_details.ingredients]

    found_match = False
    for item_name in cart_item_names:
        for ingredient in recipe_ingredients:
            # Check if one is contained in the other
            if item_name in ingredient or ingredient in item_name:
                found_match = True
                break
        if found_match:
            break

    assert found_match, (
        f"No overlap found between cart items {cart_item_names} "
        f"and recipe ingredients {recipe_ingredients}"
    )
