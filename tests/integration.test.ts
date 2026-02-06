import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, BrowserContext, Page } from "playwright";
import { OdaClient } from "../src/oda-client.js";
import path from "path";
import fs from "fs";
import os from "os";

// Use a temporary directory for browser data to keep tests isolated
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-test-"));

describe("Oda Integration Tests", () => {
  let browser: BrowserContext;
  let page: Page;
  let client: OdaClient;

  beforeAll(async () => {
    // Launch a persistent context to mimic real usage, or just a regular browser
    // Persistent context is better if we want to test cookie persistence, but for logic
    // a regular browser is fine. The server uses launchPersistentContext.
    // We'll use launchPersistentContext to be as close to the server as possible.
    browser = await chromium.launchPersistentContext(tempDir, {
      headless: true, // Set to false to see the browser
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = browser.pages()[0] || (await browser.newPage());
    client = new OdaClient(page);
  });

  afterAll(async () => {
    await browser.close();
    // Cleanup temp dir
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      console.error("Failed to clean up temp dir:", e);
    }
  });

  it("should search for products", async () => {
    const results = await client.searchProducts("melk");
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.items[0].name.toLowerCase()).toContain("melk");
    expect(results.page_url).toContain("oda.com");
  }, 30000); // Increase timeout for network operations

  it("should support pagination", async () => {
    const firstPage = await client.searchProducts("brød");
    expect(firstPage.items.length).toBeGreaterThan(0);

    const secondPage = await client.searchNextPage();
    expect(secondPage.items.length).toBeGreaterThan(0);

    // Check that items are different (rough check)
    const firstItemNames = new Set(firstPage.items.map((i) => i.name));
    
    // There might be overlap if the search is weird, but generally they should be different
    // Let's check if at least one item is new
    const hasNewItems = secondPage.items.some(
      (i) => !firstItemNames.has(i.name),
    );
    expect(hasNewItems).toBe(true);
  }, 30000);

  it("should search for recipes", async () => {
    const results = await client.searchRecipes("pizza");
    expect(results.items.length).toBeGreaterThan(0);
    expect(results.items[0].name.toLowerCase()).toContain("pizza");
  }, 30000);

  it("should get recipe details", async () => {
    // First search to populate the page with links
    await client.searchRecipes("pizza");

    // Get details for the first recipe
    const details = await client.openRecipeByIndex(0);
    expect(details.name).toBeTruthy();
    expect(details.ingredients.length).toBeGreaterThan(0);
    expect(details.instructions.length).toBeGreaterThan(0);
  }, 30000);

  // Note: Add to cart tests are tricky without a valid session/login.
  // The original python tests had a check for "0 items" if not logged in.
  // We can try to add and expect it to "work" (click the button) even if the backend rejects it
  // or requires login (which might redirect).
  // The OdaClient.addToCart checks for a specific response. If that response is 401/403 it might fail.
  // We'll skip invasive cart operations in this basic suite unless we mock the network.

  it("should support recipe pagination", async () => {
    const firstPage = await client.searchRecipes("kylling");
    expect(firstPage.items.length).toBeGreaterThan(0);

    const secondPage = await client.searchRecipesNext();
    expect(secondPage.items.length).toBeGreaterThan(0);
    
    // Check for different content
    const firstItemNames = new Set(firstPage.items.map(i => i.name));
    const hasNewItems = secondPage.items.some(i => !firstItemNames.has(i.name));
    expect(hasNewItems).toBe(true);
  }, 30000);

  it("should support recipe filtering", async () => {
    // First navigate to a category or search that has filters
    const page = await client.searchRecipes("pasta");
    
    // Find a filter to apply (e.g. 'Middag' or time)
    // We just pick the first available filter from the page result
    const availableFilters = page.filters;
    if (availableFilters.length > 0) {
        const filterToApply = availableFilters[0];
        
        const filteredPage = await client.searchRecipesFilter([filterToApply.id]);
        expect(filteredPage.items.length).toBeGreaterThan(0);
        // The URL should change or contain the filter ID
        expect(client['page'].url()).toContain(filterToApply.id);
    }
  }, 30000);

  it("should handle cart operations gracefully (without login)", async () => {
    // This test expects to be able to at least call the method.
    // It might fail to actually add if not logged in, returning false.

    // Navigate to a product page or search
    await client.searchProducts("salt");

    // Try to add the first item
    // We expect this to potentially fail or return false if not logged in,
    // but it shouldn't crash.
    const result = await client.addToCart(0);

    // If we are not logged in, this usually redirects to login or fails.
    // We just want to ensure no exception is thrown that isn't caught.
    // verification is hard without login.
    expect(result).toBeDefined();
  });
});