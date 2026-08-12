import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  extractNextData,
  parseProductPage,
  parseRecipePage,
} from "../src/oda-client.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const searchNextData = () =>
  extractNextData(
    fs.readFileSync(path.join(fixtureDir, "search-app-router.html"), "utf-8"),
  );

/** Minimal hydration data holding a single query, for the synthetic cases. */
const hydrated = (id: string, data: any) => ({
  props: {
    pageProps: {
      dehydratedState: {
        queries: [{ queryKey: [{ _id: id }], state: { data } }],
      },
    },
  },
});

const URL = "https://oda.com/no/search/products/?q=melk";

describe("parseProductPage", () => {
  it("parses products from a real page", () => {
    const page = parseProductPage(URL, searchNextData());

    expect(page.items).toHaveLength(3);
    expect(page.has_more).toBe(true);
    expect(page.items[0]).toMatchObject({
      id: 8143,
      name: "Tine Lettmelk 1% fett",
      price: 31.9,
    });
  });

  it("throws when the page has no hydration data", () => {
    expect(() => parseProductPage(URL, null)).toThrow(
      /could not load page data/i,
    );
  });

  it("throws when the search query is missing from hydration data", () => {
    expect(() => parseProductPage(URL, hydrated("somethingElse", {}))).toThrow(
      /could not find product search results/i,
    );
  });

  it("throws when the results payload has no items array", () => {
    expect(() =>
      parseProductPage(URL, hydrated("mixedSearch", { attributes: {} })),
    ).toThrow(/could not find product search results/i);
  });

  it("returns an empty page for a genuinely empty result set", () => {
    const page = parseProductPage(
      URL,
      hydrated("mixedSearch", { items: [], attributes: { hasMoreItems: false } }),
    );

    expect(page.items).toEqual([]);
    expect(page.has_more).toBe(false);
    expect(page.page_url).toBe(URL);
  });
});

describe("parseRecipePage", () => {
  const recipeUrl = "https://oda.com/no/recipes/all/?q=pizza";

  it("throws when the page has no hydration data", () => {
    expect(() => parseRecipePage(recipeUrl, null)).toThrow(
      /could not load page data/i,
    );
  });

  it("throws when the search query is missing from hydration data", () => {
    expect(() =>
      parseRecipePage(recipeUrl, hydrated("somethingElse", {})),
    ).toThrow(/could not find recipe search results/i);
  });

  it("returns an empty page for a genuinely empty result set", () => {
    const page = parseRecipePage(
      recipeUrl,
      hydrated("mixedSearch", { items: [], filters: [] }),
    );

    expect(page.items).toEqual([]);
    expect(page.filters).toEqual([]);
    expect(page.has_more).toBe(false);
  });
});
