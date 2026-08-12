import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { extractNextData } from "../src/oda-client.js";

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const fixture = (name: string) =>
  fs.readFileSync(path.join(fixtureDir, name), "utf-8");

/** Mirrors OdaClient.findDehydratedQuery so tests assert on the real contract. */
const findQuery = (nextData: any, keyPrefix: string) => {
  const queries = nextData?.props?.pageProps?.dehydratedState?.queries ?? [];
  for (const q of queries) {
    const first = Array.isArray(q.queryKey) ? q.queryKey[0] : undefined;
    if (
      first === keyPrefix ||
      (typeof first === "object" && first?._id === keyPrefix)
    ) {
      return q.state?.data ?? null;
    }
  }
  return null;
};

describe("extractNextData", () => {
  it("extracts search results from App Router flight data", () => {
    const nextData = extractNextData(fixture("search-app-router.html"));

    const data = findQuery(nextData, "mixedSearch");
    expect(data).toBeTruthy();
    expect(data.items).toHaveLength(3);
    expect(data.attributes.hasMoreItems).toBe(true);

    const first = data.items[0].attributes;
    expect(first.fullName).toBe("Tine Lettmelk 1% fett");
    expect(first.grossPrice).toBe("31.90");
    expect(first.id).toBe(8143);
  });

  it("extracts recipe details from App Router flight data", () => {
    const nextData = extractNextData(fixture("recipe-app-router.html"));

    const data = findQuery(nextData, "recipeDetailApi");
    expect(data).toBeTruthy();
    expect(data.title).toBe("Pizza Parma");
    expect(data.ingredients.length).toBeGreaterThan(0);
    expect(data.instructions.instructions.length).toBeGreaterThan(0);
  });

  it("merges queries from every hydration boundary on the page", () => {
    const nextData = extractNextData(fixture("search-app-router.html"));

    // "user" lives in a different boundary than "mixedSearch"
    expect(findQuery(nextData, "mixedSearch")).toBeTruthy();
    expect(nextData.props.pageProps.dehydratedState.queries).toHaveLength(2);
  });

  it("still reads the legacy __NEXT_DATA__ script tag", () => {
    const nextData = extractNextData(fixture("legacy-next-data.html"));

    expect(findQuery(nextData, "mixedSearch")).toBeTruthy();
  });

  it("returns null when the page has no hydration data", () => {
    expect(extractNextData("<html><body>nothing here</body></html>")).toBeNull();
  });
});
