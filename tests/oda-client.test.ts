import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OdaClient, summarizeCartMutation } from "../src/oda-client.js";

const apiResponse = (
  status: number,
  json: ReturnType<typeof vi.fn> = vi.fn(),
  body = "",
) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { getSetCookie: () => [] },
  json,
  text: vi.fn().mockResolvedValue(body),
});

describe("OdaClient cookie permissions", () => {
  it("repairs an existing cookie file to mode 0600 before loading it", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, JSON.stringify({ csrftoken: "secret" }), {
      mode: 0o666,
    });
    fs.chmodSync(cookiePath, 0o666);

    try {
      const client = new OdaClient(cookiePath);
      expect(client.getCsrfToken()).toBe("secret");
      expect(fs.statSync(cookiePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("repairs an existing cookie file to mode 0600 when saving", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, "{}", { mode: 0o600 });

    try {
      const client = new OdaClient(cookiePath);
      fs.chmodSync(cookiePath, 0o666);
      client.saveCookies();
      expect(fs.statSync(cookiePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OdaClient API error handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unsuccessful frequent-products order-list response before parsing JSON", async () => {
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(401, json, "not authenticated")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).rejects.toThrow(
      /frequent products.*order list.*HTTP 401.*not authenticated/i,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects an unsuccessful frequent-products order-detail response before parsing JSON", async () => {
    const detailJson = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [{ orders: [{ order_number: "ORDER-1" }] }],
              has_more: false,
            }),
          ),
        )
        .mockResolvedValueOnce(apiResponse(503, detailJson, "try later")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).rejects.toThrow(
      /frequent products.*order ORDER-1.*HTTP 503.*try later/i,
    );
    expect(detailJson).not.toHaveBeenCalled();
  });

  it("stops when frequent-products pagination repeats a URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [],
              has_more: true,
              get_more_url: "https://oda.com/api/v1/orders/?before=1",
            }),
          ),
        )
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [],
              has_more: true,
              get_more_url: "https://oda.com/api/v1/orders/?before=1",
            }),
          ),
        ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).rejects.toThrow(
      /pagination repeated.*before=1/i,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects unsuccessful cart recommendations before parsing JSON", async () => {
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(403, json, "forbidden")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getCartRecommendations()).rejects.toThrow(
      /cart recommendations.*HTTP 403.*forbidden/i,
    );
    expect(json).not.toHaveBeenCalled();
  });
});

const htmlResponse = (html: string) => ({
  ok: true,
  status: 200,
  headers: { getSetCookie: () => [] },
  json: vi.fn(),
  text: vi.fn().mockResolvedValue(html),
});

const recipePage = (jsonLd: unknown) =>
  `<html><head><script type="application/ld+json">${JSON.stringify(
    jsonLd,
  )}</script></head><body></body></html>`;

describe("OdaClient recipe JSON-LD fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const recipe = {
    "@type": "Recipe",
    name: "Fiskesuppe",
    description: "Kremet suppe",
    recipeIngredient: ["400 g laks"],
    recipeInstructions: [{ text: "Kok opp" }],
    image: ["https://oda.com/soup.jpg"],
  };

  it("finds the recipe when JSON-LD is a top-level array", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          htmlResponse(recipePage([{ "@type": "WebSite" }, recipe])),
        ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const details = await client.getRecipeDetails(608);

    expect(details.name).toBe("Fiskesuppe");
    expect(details.ingredients).toEqual(["400 g laks"]);
    expect(details.instructions).toEqual(["Kok opp"]);
    expect(details.image_url).toBe("https://oda.com/soup.jpg");
  });

  it("finds the recipe when JSON-LD wraps it in @graph", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        htmlResponse(
          recipePage({
            "@context": "https://schema.org",
            "@graph": [{ "@type": "Organization" }, recipe],
          }),
        ),
      ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    expect((await client.getRecipeDetails(608)).name).toBe("Fiskesuppe");
  });

  it("finds the recipe when the script tag carries extra attributes", async () => {
    const html = `<html><head><script id="recipe-ld" type='application/ld+json' data-x="1">${JSON.stringify(
      recipe,
    )}</script></head></html>`;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));
    const client = new OdaClient("/nonexistent/cookies.json");

    expect((await client.getRecipeDetails(608)).name).toBe("Fiskesuppe");
  });
});

describe("OdaClient frequent products", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("counts an order once even when a product appears in several item groups", async () => {
    // Oda splits order items into groups (standalone items vs. recipe-grouped
    // items), so the same product can appear more than once in one order.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [{ orders: [{ order_number: "ORDER-1" }] }],
              has_more: false,
            }),
          ),
        )
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              items: {
                item_groups: [
                  {
                    items: [
                      { product_id: 1, description: "Melk", quantity: 1 },
                    ],
                  },
                  {
                    items: [
                      { product_id: 1, description: "Melk", quantity: 2 },
                    ],
                  },
                ],
              },
            }),
          ),
        ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const frequent = await client.getFrequentProducts();

    expect(frequent).toEqual([
      { id: 1, name: "Melk", times_ordered: 1, total_quantity: 3 },
    ]);
  });

  it("counts a product once per order across separate orders", async () => {
    const orderDetail = () =>
      apiResponse(
        200,
        vi.fn().mockResolvedValue({
          items: {
            item_groups: [
              { items: [{ product_id: 1, description: "Melk", quantity: 1 }] },
            ],
          },
        }),
      );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          apiResponse(
            200,
            vi.fn().mockResolvedValue({
              results: [
                { orders: [{ order_number: "A" }, { order_number: "B" }] },
              ],
              has_more: false,
            }),
          ),
        )
        .mockResolvedValueOnce(orderDetail())
        .mockResolvedValueOnce(orderDetail()),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const frequent = await client.getFrequentProducts();

    expect(frequent[0].times_ordered).toBe(2);
    expect(frequent[0].total_quantity).toBe(2);
  });
});

describe("OdaClient cookie chmod failures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A cookie file the current user cannot chmod (shared data-dir, changed
  // container UID, root-created file) must still be readable, otherwise the
  // user is silently logged out.
  it("still loads cookies when the file cannot be chmodded", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, JSON.stringify({ csrftoken: "secret" }));
    const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), {
        code: "EPERM",
      });
    });

    try {
      const client = new OdaClient(cookiePath);
      expect(client.getCsrfToken()).toBe("secret");
      expect(chmod).toHaveBeenCalled();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("still writes cookies when the file cannot be chmodded", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, JSON.stringify({ csrftoken: "secret" }));

    try {
      const client = new OdaClient(cookiePath);
      vi.spyOn(fs, "chmodSync").mockImplementation(() => {
        throw Object.assign(new Error("EPERM: operation not permitted"), {
          code: "EPERM",
        });
      });

      expect(() => client.saveCookies()).not.toThrow();
      expect(JSON.parse(fs.readFileSync(cookiePath, "utf-8"))).toEqual({
        csrftoken: "secret",
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OdaClient saved list argument validation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const client = () => new OdaClient("/nonexistent/cookies.json");

  it.each([
    ["getSavedListDetails", (c: OdaClient) => c.getSavedListDetails(0)],
    ["addProductToSavedList", (c: OdaClient) => c.addProductToSavedList(0, 5)],
    [
      "removeProductFromSavedList",
      (c: OdaClient) => c.removeProductFromSavedList(-1, 5),
    ],
    ["addSavedListToCart", (c: OdaClient) => c.addSavedListToCart(1.5)],
  ])(
    "%s rejects a non-positive-integer list ID without a request",
    async (_name, call) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(call(client())).rejects.toThrow(
        /List ID must be a positive integer/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("OdaClient recipe fallback error reporting", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports why the primary recipe lookup failed when the fallback finds nothing", async () => {
    // __NEXT_DATA__ is present but carries no recipe query, and the page has no
    // JSON-LD, so both paths fail and the original reason must survive.
    const html =
      '<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"dehydratedState":{"queries":[]}}}}</script></html>';
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(htmlResponse(html)));
    const client = new OdaClient("/nonexistent/cookies.json");

    const error = await client.getRecipeDetails(608).catch((e) => e);

    expect(error.message).toMatch(/Could not load recipe page for ID 608/);
    expect(error.message).toMatch(/Could not find recipe data for ID 608/);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });
});

describe("OdaClient order pagination URLs", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const pageOne = (getMoreUrl: string) =>
    apiResponse(
      200,
      vi.fn().mockResolvedValue({
        results: [],
        has_more: true,
        get_more_url: getMoreUrl,
      }),
    );

  it("refuses to follow a pagination URL to another host", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        pageOne("https://evil.example.com/api/v1/orders/"),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).rejects.toThrow(
      /refused.*pagination URL.*evil\.example\.com/i,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves a relative pagination URL against the Oda origin", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageOne("/api/v1/orders/?before=2"))
      .mockResolvedValueOnce(
        apiResponse(
          200,
          vi.fn().mockResolvedValue({ results: [], has_more: false }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getFrequentProducts()).resolves.toEqual([]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://oda.com/api/v1/orders/?before=2",
    );
  });
});

describe("OdaClient saved list API errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the response body and an auth hint when listing saved lists fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(403, vi.fn(), "forbidden")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getSavedLists()).rejects.toThrow(
      /Get saved lists failed: HTTP 403 \(authentication may be required or expired\).*forbidden/,
    );
  });

  it("includes the response body when reading a saved list fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(500, vi.fn(), "boom")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getSavedListDetails(7)).rejects.toThrow(
      /Get saved list failed: HTTP 500.*boom/,
    );
  });
});

describe("OdaClient cart mutation errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["addToCart", (c: OdaClient) => c.addToCart(1), "Add to cart"],
    [
      "removeFromCart",
      (c: OdaClient) => c.removeFromCart(1),
      "Remove from cart",
    ],
    ["clearCart", (c: OdaClient) => c.clearCart(), "Clear cart"],
    [
      "removeRecipeFromCart",
      (c: OdaClient) => c.removeRecipeFromCart(1),
      "Remove recipe from cart",
    ],
    [
      "addProductToSavedList",
      (c: OdaClient) => c.addProductToSavedList(1, 2),
      "Add product to saved list",
    ],
    [
      "removeProductFromSavedList",
      (c: OdaClient) => c.removeProductFromSavedList(1, 2),
      "Remove product from saved list",
    ],
  ])(
    "%s explains that a 403 may be an auth problem",
    async (_name, call, operation) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(apiResponse(403, vi.fn(), "forbidden")),
      );
      const client = new OdaClient("/nonexistent/cookies.json");

      await expect(call(client)).rejects.toThrow(
        new RegExp(
          `${operation} failed: HTTP 403 \\(authentication may be required or expired\\).*forbidden`,
        ),
      );
    },
  );
});

describe("OdaClient recipe cart errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("explains that a 403 on adding a recipe may be an auth problem", async () => {
    const nextData = {
      props: {
        pageProps: {
          dehydratedState: {
            queries: [
              {
                queryKey: [{ _id: "recipeDetailApi" }],
                state: {
                  data: {
                    title: "Fiskesuppe",
                    ingredients: [{ product: { id: 34 }, portionQuantity: 1 }],
                  },
                },
              },
            ],
          },
        },
      },
    };
    const html = `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
      nextData,
    )}</script></html>`;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(htmlResponse(html))
        .mockResolvedValueOnce(apiResponse(403, vi.fn(), "forbidden")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.addRecipeToCart(1, 2)).rejects.toThrow(
      /Add recipe to cart failed: HTTP 403 \(authentication may be required or expired\).*forbidden/,
    );
  });
});

describe("OdaClient saved list mutation requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const okResponse = () => apiResponse(200, vi.fn().mockResolvedValue({}));

  it("adds a product with the product-list payload shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    await client.addProductToSavedList(12, 34, 3);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oda.com/api/v1/product-lists/12/products/");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual([
      { productId: 34, quantity: 3, delete: false },
    ]);
    expect(init.headers.Referer).toBe(
      "https://oda.com/no/account/lists/details/12/",
    );
  });

  it("removes a product with the product-list delete payload shape", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    await client.removeProductFromSavedList(12, 34);

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual([
      { productId: 34, quantity: -1, delete: true },
    ]);
  });

  it("sends saved list items to the cart as product_id/quantity pairs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        apiResponse(
          200,
          vi.fn().mockResolvedValue({
            id: 12,
            title: "Ukesmeny",
            items: [
              { quantity: 2, product: { id: 34, full_name: "Melk" } },
              { quantity: 1, product: { id: 56, full_name: "Brød" } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    await client.addSavedListToCart(12);

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("https://oda.com/api/v1/cart/items/");
    expect(JSON.parse(init.body)).toEqual({
      items: [
        { product_id: 34, quantity: 2 },
        { product_id: 56, quantity: 1 },
      ],
    });
  });
});

describe("OdaClient cart recommendations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes recommended products regardless of the response wrapper", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        apiResponse(
          200,
          vi.fn().mockResolvedValue({
            groups: [
              {
                title: "Ofte kjøpt",
                items: [
                  {
                    product: {
                      id: 34,
                      full_name: "Tine Melk 1,75 %",
                      name_extra: "1 l",
                      gross_price: "24.90",
                      gross_unit_price: "24.90",
                      unit_price_quantity_abbreviation: "l",
                    },
                  },
                ],
              },
            ],
          }),
        ),
      ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getCartRecommendations()).resolves.toEqual([
      {
        id: 34,
        name: "Tine Melk 1,75 %",
        subtitle: "1 l",
        price: 24.9,
        relative_price: 24.9,
        relative_price_unit: "/l",
      },
    ]);
  });

  it("returns an empty list when the response holds no products", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          apiResponse(200, vi.fn().mockResolvedValue({ groups: [] })),
        ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getCartRecommendations()).resolves.toEqual([]);
  });
});

describe("OdaClient frequent products request volume", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches order details concurrently but never more than 5 at a time", async () => {
    const orders = Array.from({ length: 12 }, (_, i) => ({
      order_number: `ORDER-${i}`,
    }));
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (!/ORDER-/.test(url)) {
        return apiResponse(
          200,
          vi.fn().mockResolvedValue({ results: [{ orders }], has_more: false }),
        );
      }
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight--;
      return apiResponse(
        200,
        vi.fn().mockResolvedValue({
          items: {
            item_groups: [
              { items: [{ product_id: 1, description: "Melk", quantity: 1 }] },
            ],
          },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    const frequent = await client.getFrequentProducts();

    expect(frequent).toEqual([
      { id: 1, name: "Melk", times_ordered: 12, total_quantity: 12 },
    ]);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(5);
  });
});

describe("OdaClient session cookie persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const responseWithCookies = (cookies: string[]) => ({
    ok: true,
    status: 200,
    headers: { getSetCookie: () => cookies },
    json: vi.fn().mockResolvedValue({ items: [] }),
    text: vi.fn().mockResolvedValue(""),
  });

  it("persists refreshed cookies to an existing cookie file", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, JSON.stringify({ sessionid: "old" }), {
      mode: 0o600,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          responseWithCookies(["sessionid=new; Path=/; HttpOnly"]),
        ),
    );

    try {
      const client = new OdaClient(cookiePath);
      await client.getCartContents();
      const saved = JSON.parse(fs.readFileSync(cookiePath, "utf-8"));
      expect(saved.sessionid).toBe("new");
      expect(fs.statSync(cookiePath).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("leaves the cookie file untouched when Set-Cookie changes nothing", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, JSON.stringify({ sessionid: "same" }), {
      mode: 0o600,
    });
    const before = fs.statSync(cookiePath).mtimeMs;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(responseWithCookies(["sessionid=same; Path=/"])),
    );

    try {
      const client = new OdaClient(cookiePath);
      await client.getCartContents();
      expect(fs.statSync(cookiePath).mtimeMs).toBe(before);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not create a cookie file for an anonymous client", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(responseWithCookies(["sessionid=anon"])),
    );

    try {
      const client = new OdaClient(cookiePath);
      await client.getCartContents();
      expect(fs.existsSync(cookiePath)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OdaClient cart fetch errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects with an auth hint when fetching the cart fails with 401", async () => {
    const json = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(401, json, "not authenticated")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getCartContents()).rejects.toThrow(
      /Get cart failed: HTTP 401 \(authentication may be required or expired\).*not authenticated/,
    );
    expect(json).not.toHaveBeenCalled();
  });

  it("rejects when the cart response is not parseable JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        apiResponse(
          200,
          vi.fn().mockRejectedValue(new SyntaxError("Unexpected token <")),
        ),
      ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getCartContents()).rejects.toThrow(
      /Get cart failed: unparseable response/,
    );
  });

  it("returns the parsed items for a successful cart response", async () => {
    const cart = {
      items: [
        {
          quantity: 2,
          product: {
            id: 42,
            full_name: "Tine Lettmelk",
            name_extra: "1,75 l",
            gross_price: "31.90",
            gross_unit_price: "18.23",
            unit_price_quantity_abbreviation: "l",
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(apiResponse(200, vi.fn().mockResolvedValue(cart))),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const result = await client.getCartContents();
    expect(result.items).toEqual([
      {
        id: 42,
        name: "Tine Lettmelk",
        subtitle: "1,75 l",
        quantity: 2,
        price: 31.9,
        relative_price: 18.23,
        relative_price_unit: "/l",
        item_id: 0,
        line_total: 63.8,
      },
    ]);
  });
});

describe("OdaClient login error classification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const loginPage = () => ({
    ok: true,
    status: 200,
    headers: { getSetCookie: () => ["csrftoken=tok; Path=/"] },
    json: vi.fn(),
    text: vi.fn().mockResolvedValue("<html></html>"),
  });

  it("returns false for rejected credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(loginPage())
        .mockResolvedValueOnce(apiResponse(401, vi.fn(), "bad credentials")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.login("user@example.com", "wrong")).resolves.toBe(
      false,
    );
  });

  it("throws on a server error instead of reporting bad credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(loginPage())
        .mockResolvedValueOnce(apiResponse(500, vi.fn(), "boom")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.login("user@example.com", "pw")).rejects.toThrow(
      /Login failed: HTTP 500.*boom/,
    );
  });
});

describe("OdaClient saved list pagination", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const listPage = (ids: number[], next: string | null) =>
    apiResponse(
      200,
      vi.fn().mockResolvedValue({
        next,
        previous: null,
        results: ids.map((id) => ({
          id,
          title: `Liste ${id}`,
          description: "",
          number_of_products: 1,
          number_of_items: 1,
          total_quantity: 1,
          url: `/no/lists/${id}/`,
        })),
      }),
    );

  it("follows next links across pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        listPage([1, 2], "https://oda.com/api/v1/product-lists/?page=2"),
      )
      .mockResolvedValueOnce(listPage([3], null));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    const lists = await client.getSavedLists();
    expect(lists.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stops on a pagination loop", async () => {
    const url = "https://oda.com/api/v1/product-lists/?filter=product_lists";
    const fetchMock = vi.fn().mockResolvedValue(listPage([1], url));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    const lists = await client.getSavedLists();
    expect(lists.map((l) => l.id)).toEqual([1]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("OdaClient cart totals and grouping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps cart totals and annotates group membership per line", async () => {
    // Mirrors the documented GET /api/v1/cart/ response (ODA_API.md)
    const cartResponse = {
      id: 0,
      label_text: "3 varer",
      product_quantity_count: 3,
      display_price: "1068.40",
      total_gross_amount: "1116.29",
      items: [
        {
          item_id: 111,
          quantity: 2,
          display_price_total: "63.80",
          product: {
            id: 42,
            full_name: "Tine Lettmelk",
            name_extra: "1,75 l",
            gross_price: "31.90",
            gross_unit_price: "18.23",
            unit_price_quantity_abbreviation: "l",
          },
        },
      ],
      groups: [
        {
          id: "recipe-1",
          title: "Pizza Margherita",
          group_type: "recipe",
          items: [
            {
              item_id: 222,
              quantity: 1,
              display_price_total: "29.90",
              product: {
                id: 9452,
                full_name: "Avokado modnet Chile / Spania/ Marokko",
                name: "Avokado modnet",
                name_extra: "Chile / Spania/ Marokko, 2 stk",
                gross_price: "29.90",
                gross_unit_price: "14.95",
                unit_price_quantity_abbreviation: "stk",
              },
            },
          ],
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          apiResponse(200, vi.fn().mockResolvedValue(cartResponse)),
        ),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const cart = await client.getCartContents();
    expect(cart.label_text).toBe("3 varer");
    expect(cart.product_quantity_count).toBe(3);
    expect(cart.display_price).toBe(1068.4);
    expect(cart.total_gross_amount).toBe(1116.29);
    expect(cart.items).toHaveLength(2);

    const [milk, avocado] = cart.items;
    expect(milk.item_id).toBe(111);
    expect(milk.line_total).toBe(63.8);
    expect(milk.group_title).toBeUndefined();

    expect(avocado.id).toBe(9452);
    expect(avocado.item_id).toBe(222);
    expect(avocado.line_total).toBe(29.9);
    expect(avocado.group_title).toBe("Pizza Margherita");
    expect(avocado.group_type).toBe("recipe");
  });
});

describe("OdaClient recipe ingredient mapping", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const recipeData = {
    title: "Pizza Margherita",
    lead: "Klassisk pizza",
    ingredientsDisplayList: [
      { title: "Mozzarella, fersk", displayQuantity: "250", displayUnit: "g" },
      { title: "Basilikum", displayQuantity: "1", displayUnit: "pott" },
    ],
    ingredients: [
      {
        product: { id: 4321, full_name: "Mozzarella" },
        portionQuantity: "0.5",
      },
      {},
    ],
    instructions: { instructions: [{ text: "Stek pizzaen" }] },
  };

  const hydrationHtml = () => {
    const queries = [
      { queryKey: [{ _id: "recipeDetailApi" }], state: { data: recipeData } },
    ];
    return `<html><script>self.__next_f.push([1,${JSON.stringify(
      `"queries":${JSON.stringify(queries)}`,
    )}])</script></html>`;
  };

  it("exposes structured ingredients with product mapping", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [], get: () => "text/html" },
        json: vi.fn(),
        text: vi.fn().mockResolvedValue(hydrationHtml()),
      }),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const detail = await client.getRecipeDetails(1);
    expect(detail.name).toBe("Pizza Margherita");
    expect(detail.ingredients).toEqual([
      "250 g Mozzarella, fersk",
      "1 pott Basilikum",
    ]);
    expect(detail.ingredient_items).toEqual([
      {
        title: "Mozzarella, fersk",
        quantity: 250,
        unit: "g",
        product_id: 4321,
        portion_quantity: 0.5,
      },
      { title: "Basilikum", quantity: 1, unit: "pott" },
    ]);
  });
});

describe("OdaClient delivery slots", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("groups slots by local day and parses deadlines and prices", async () => {
    const payload = {
      time_zone: "Europe/Oslo",
      delivery_slots: [
        {
          id: 1,
          open_datetime: "2026-09-04T03:00:00Z",
          close_datetime: "2026-09-04T05:00:00Z",
          cutoff_time: "2026-09-03T18:00:00Z",
          price: "kr 79",
          is_full: false,
          is_unavailable: false,
          is_cheapest: true,
        },
        {
          id: 2,
          open_datetime: "2026-09-04T15:00:00Z",
          close_datetime: "2026-09-04T17:00:00Z",
          cutoff_time: "2026-09-04T10:00:00Z",
          price: "kr 99",
          is_full: true,
          is_unavailable: false,
        },
        {
          id: 3,
          open_datetime: "2026-09-05T03:00:00Z",
          close_datetime: "2026-09-05T05:00:00Z",
          cutoff_time: "2026-09-04T18:00:00Z",
          price: "kr 69",
          is_full: false,
          is_unavailable: true,
          unavailable_description: "Ikke tilgjengelig",
          validation_messages: [
            {
              type: "product_availability_date",
              description: "Varen er utsolgt",
            },
          ],
        },
      ],
      validation_messages: [
        {
          type: "product_availability_date",
          description: "Noen varer er ikke tilgjengelige",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(apiResponse(200, vi.fn().mockResolvedValue(payload))),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const slots = await client.getDeliverySlots();
    expect(slots.time_zone).toBe("Europe/Oslo");
    expect(slots.validation_messages).toEqual([
      "Noen varer er ikke tilgjengelige",
    ]);
    expect(slots.days.map((d) => d.date)).toEqual([
      "2026-09-04",
      "2026-09-05",
    ]);

    const [day1, day2] = slots.days;
    expect(day1.slots).toHaveLength(2);
    expect(day1.slots[0]).toMatchObject({
      id: 1,
      deadline: "2026-09-03T18:00:00Z",
      price: 79,
      price_label: "kr 79",
      is_available: true,
      is_cheapest: true,
    });
    expect(day1.slots[1].is_available).toBe(false);
    expect(day1.slots[0].validation_messages).toBeUndefined();
    expect(day2.slots[0]).toMatchObject({
      is_available: false,
      unavailable_description: "Ikke tilgjengelig",
      validation_messages: ["Varen er utsolgt"],
    });
  });

  it("raises with the auth hint on 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(apiResponse(403, vi.fn(), "forbidden")),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    await expect(client.getDeliverySlots()).rejects.toThrow(
      /Get delivery slots failed: HTTP 403/,
    );
  });
});

describe("OdaClient cookie persistence failures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps serving API calls when the cookie file cannot be written", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-oda-cookie-"));
    const cookiePath = path.join(tempDir, "cookies.json");
    fs.writeFileSync(cookiePath, JSON.stringify({ sessionid: "old" }), {
      mode: 0o600,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ...apiResponse(200, vi.fn().mockResolvedValue({ items: [] })),
        headers: { getSetCookie: () => ["sessionid=new; Path=/"] },
      }),
    );
    vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
      throw Object.assign(new Error("read-only"), { code: "EROFS" });
    });

    try {
      const client = new OdaClient(cookiePath);
      await expect(client.getCartContents()).resolves.toMatchObject({
        items: [],
      });
    } finally {
      vi.restoreAllMocks();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("OdaClient recipe ingredient id join", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const hydrationHtml = (recipeData: unknown) => {
    const queries = [
      { queryKey: [{ _id: "recipeDetailApi" }], state: { data: recipeData } },
    ];
    return `<html><script>self.__next_f.push([1,${JSON.stringify(
      `"queries":${JSON.stringify(queries)}`,
    )}])</script></html>`;
  };

  it("joins display entries to products by id, not position", async () => {
    const recipeData = {
      title: "Taco",
      ingredientsDisplayList: [
        {
          id: 1,
          title: "Tortilla",
          displayQuantity: "8.000",
          displayUnit: "stk",
        },
        { id: 2, title: "Salt", displayQuantity: "1.000", displayUnit: "ts" },
        {
          id: 3,
          title: "Kjøttdeig",
          displayQuantity: "400.000",
          displayUnit: "g",
        },
      ],
      ingredients: [
        {
          id: 3,
          ingredient: { id: 30, title: "Kjøttdeig" },
          portionQuantity: "0.250",
          product: { id: 300, fullName: "Kjøttdeig 400 g" },
        },
        {
          id: 1,
          ingredient: { id: 10, title: "Tortilla" },
          portionQuantity: "2.000",
          product: { id: 100, fullName: "Tortilla 8 stk" },
        },
        {
          id: 4,
          ingredient: { id: 40, title: "Rømme" },
          portionQuantity: "0.500",
          product: { id: 400, fullName: "Rømme 300 g" },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { getSetCookie: () => [], get: () => "text/html" },
        json: vi.fn(),
        text: vi.fn().mockResolvedValue(hydrationHtml(recipeData)),
      }),
    );
    const client = new OdaClient("/nonexistent/cookies.json");

    const detail = await client.getRecipeDetails(1);
    expect(detail.ingredient_items).toEqual([
      {
        title: "Tortilla",
        quantity: 8,
        unit: "stk",
        product_id: 100,
        portion_quantity: 2,
      },
      { title: "Salt", quantity: 1, unit: "ts" },
      {
        title: "Kjøttdeig",
        quantity: 400,
        unit: "g",
        product_id: 300,
        portion_quantity: 0.25,
      },
      {
        title: "Rømme",
        quantity: 0,
        unit: "",
        product_id: 400,
        portion_quantity: 0.5,
      },
    ]);
  });
});

describe("OdaClient cart mutations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const cartPayload = (quantity: number, otherProduct = false) => ({
    label_text: `${quantity} varer`,
    product_quantity_count: quantity,
    display_price: "10.00",
    total_gross_amount: "10.00",
    items: [
      ...(quantity > 0
        ? [
            {
              item_id: 1,
              quantity,
              display_price_total: "10.00",
              product: { id: 7, full_name: "Vare", gross_price: "5.00" },
            },
          ]
        : []),
      ...(otherProduct
        ? [
            {
              item_id: 2,
              quantity: 1,
              display_price_total: "3.00",
              product: { id: 8, full_name: "Annen vare", gross_price: "3.00" },
            },
          ]
        : []),
    ],
  });
  const cartResponse = (quantity: number, otherProduct = false) =>
    apiResponse(
      200,
      vi.fn().mockResolvedValue(cartPayload(quantity, otherProduct)),
    );
  const postedItems = (fetchMock: ReturnType<typeof vi.fn>, call: number) =>
    JSON.parse(fetchMock.mock.calls[call][1].body).items;

  it("addToCart returns the cart from the POST response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(cartResponse(1));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    const cart = await client.addToCart(7);
    expect(cart.product_quantity_count).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads the cart when a mutation response is not a cart", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(apiResponse(200, vi.fn().mockResolvedValue({})))
      .mockResolvedValueOnce(cartResponse(2));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    const cart = await client.removeFromCart(7);
    expect(cart.product_quantity_count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("setCartQuantity posts the delta needed to reach the target", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cartResponse(2))
      .mockResolvedValueOnce(cartResponse(5));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    const cart = await client.setCartQuantity(7, 5);
    expect(cart.product_quantity_count).toBe(5);
    expect(postedItems(fetchMock, 1)).toEqual([{ product_id: 7, quantity: 3 }]);
  });

  it("setCartQuantity posts a negative delta down to zero", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(cartResponse(2))
      .mockResolvedValueOnce(cartResponse(0));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    await client.setCartQuantity(7, 0);
    expect(postedItems(fetchMock, 1)).toEqual([
      { product_id: 7, quantity: -2 },
    ]);
  });

  it("setCartQuantity does not post when the cart already matches", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(cartResponse(2));
    vi.stubGlobal("fetch", fetchMock);
    const client = new OdaClient("/nonexistent/cookies.json");

    const cart = await client.setCartQuantity(7, 2);
    expect(cart.product_quantity_count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("setCartQuantity rejects non-integer and negative quantities", async () => {
    const client = new OdaClient("/nonexistent/cookies.json");
    await expect(client.setCartQuantity(7, 1.5)).rejects.toThrow(
      /non-negative integer/,
    );
    await expect(client.setCartQuantity(7, -1)).rejects.toThrow(
      /non-negative integer/,
    );
  });

  it("summarizes a mutation as cart totals plus the product's lines", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cartResponse(1, true)));
    const client = new OdaClient("/nonexistent/cookies.json");

    const summary = summarizeCartMutation(await client.addToCart(7), 7);
    expect(summary).toMatchObject({
      label_text: "1 varer",
      product_quantity_count: 1,
      display_price: 10,
    });
    expect(summary.lines.map((line) => line.id)).toEqual([7]);
  });
});

describe("OdaClient cart recommendation options", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const recommendations = {
    groups: [
      {
        items: [1, 2, 3, 4].map((id) => ({
          id,
          full_name: `Vare ${id}`,
          gross_price: "10.00",
        })),
      },
    ],
  };
  const fetchWithCart = (cartIds: number[]) =>
    vi.fn((url: string) =>
      Promise.resolve(
        url.includes("/recommendations/")
          ? apiResponse(200, vi.fn().mockResolvedValue(recommendations))
          : apiResponse(
              200,
              vi.fn().mockResolvedValue({
                items: cartIds.map((id) => ({
                  quantity: 1,
                  product: { id, full_name: `Vare ${id}` },
                })),
              }),
            ),
      ),
    );

  it("stops at the limit", async () => {
    vi.stubGlobal("fetch", fetchWithCart([]));
    const client = new OdaClient("/nonexistent/cookies.json");

    const recs = await client.getCartRecommendations({ limit: 2 });
    expect(recs.map((r) => r.id)).toEqual([1, 2]);
  });

  it("still fills the limit after excluding products in the cart", async () => {
    vi.stubGlobal("fetch", fetchWithCart([1, 2]));
    const client = new OdaClient("/nonexistent/cookies.json");

    const recs = await client.getCartRecommendations({
      limit: 2,
      excludeInCart: true,
    });
    expect(recs.map((r) => r.id)).toEqual([3, 4]);
  });

  it("rejects a non-positive limit", async () => {
    const client = new OdaClient("/nonexistent/cookies.json");
    await expect(client.getCartRecommendations({ limit: 0 })).rejects.toThrow(
      /positive integer/,
    );
  });
});
