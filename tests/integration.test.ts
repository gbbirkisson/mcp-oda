import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { OdaClient } from "../src/oda-client.js";
import path from "path";
import fs from "fs";
import os from "os";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-test-"));
const cookiePath = path.join(tempDir, "cookies.json");

describe("Oda Integration Tests", () => {
  let client: OdaClient;

  beforeAll(() => {
    client = new OdaClient(cookiePath);
  });

  afterAll(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Failed to clean up temp dir:", e);
    }
  });

  it("should search for products", async () => {
    const results = await client.searchProducts("melk");
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.page_url).toContain("oda.com");
  }, 30000);

  it("should support pagination", async () => {
    const firstPage = await client.searchProducts("brød");
    expect(firstPage.items.length).toBeGreaterThan(0);
    expect(firstPage.has_more).toBeDefined();

    const secondPage = await client.searchProducts("brød", 2);
    expect(secondPage.items.length).toBeGreaterThan(0);

    const firstItemNames = new Set(firstPage.items.map((i) => i.name));
    const hasNewItems = secondPage.items.some(
      (i) => !firstItemNames.has(i.name),
    );
    expect(hasNewItems).toBe(true);
  }, 30000);

  it("should search for recipes", async () => {
    const results = await client.searchRecipes("pizza");
    expect(results.items.length).toBeGreaterThan(0);
  }, 30000);

  it("should get recipe details", async () => {
    const results = await client.searchRecipes("pizza");
    const details = await client.getRecipeDetails(results.items[0].id);
    expect(details.name).toBeTruthy();
    expect(details.ingredients.length).toBeGreaterThan(0);
    expect(details.instructions.length).toBeGreaterThan(0);
  }, 30000);

  it("should support recipe pagination", async () => {
    const firstPage = await client.searchRecipes("kylling");
    expect(firstPage.items.length).toBeGreaterThan(0);
    expect(firstPage.has_more).toBeDefined();

    const secondPage = await client.searchRecipes("kylling", 2);
    expect(secondPage.items.length).toBeGreaterThan(0);

    const firstItemNames = new Set(firstPage.items.map((i) => i.name));
    const hasNewItems = secondPage.items.some(
      (i) => !firstItemNames.has(i.name),
    );
    expect(hasNewItems).toBe(true);
  }, 30000);

  it("should support recipe filtering", async () => {
    const page = await client.searchRecipes("pasta");
    const availableFilters = page.filters;
    if (availableFilters.length > 0) {
      const filterToApply = availableFilters[0];
      const filteredPage = await client.searchRecipes("pasta", undefined, [
        filterToApply.id,
      ]);
      expect(filteredPage.items.length).toBeGreaterThan(0);
      expect(filteredPage.items.length).toBeLessThanOrEqual(
        page.items.length,
      );
    }
  }, 30000);

  it("should add and remove a product from cart", async () => {
    const results = await client.searchProducts("salt");
    const productId = results.items[0].id;

    // Add to cart (throws on failure)
    await client.addToCart(productId);

    // Verify product is in cart
    const cartAfterAdd = await client.getCartContents();
    expect(cartAfterAdd.some((item) => item.id === productId)).toBe(true);

    // Remove from cart (throws on failure)
    await client.removeFromCart(productId);

    // Verify product is no longer in cart
    const cartAfterRemove = await client.getCartContents();
    expect(cartAfterRemove.some((item) => item.id === productId)).toBe(false);
  }, 60000);

  it("should clear the cart", async () => {
    const results = await client.searchProducts("salt");
    const productId = results.items[0].id;

    // Add an item first (throws on failure)
    await client.addToCart(productId);

    // Verify cart is non-empty
    const cartBefore = await client.getCartContents();
    expect(cartBefore.length).toBeGreaterThan(0);

    // Clear cart (throws on failure)
    await client.clearCart();

    // Verify cart is empty
    const cartAfter = await client.getCartContents();
    expect(cartAfter.length).toBe(0);
  }, 60000);

  it("should add and remove a recipe from cart", async () => {
    const results = await client.searchRecipes("pizza");
    const recipeId = results.items[0].id;

    // Add recipe to cart (uses cart items API with recipe ingredients)
    await client.addRecipeToCart(recipeId, 2);

    // Verify cart has items from the recipe
    const cartAfterAdd = await client.getCartContents();
    expect(cartAfterAdd.length).toBeGreaterThan(0);

    // Remove recipe from cart
    await client.removeRecipeFromCart(recipeId);
  }, 60000);

  it("should dump page data", async () => {
    const result = await client.dump(
      "https://oda.com/no/search/products/?q=melk",
    );
    expect(result.status).toBe(200);
    expect(result.finalUrl).toContain("oda.com");
  }, 30000);
});
