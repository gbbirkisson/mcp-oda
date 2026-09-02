import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { OdaClient } from "../src/oda-client.js";

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
        },
      ],
      validator_messages: ["Noen varer er ikke tilgjengelige"],
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
    expect(day2.slots[0]).toMatchObject({
      is_available: false,
      unavailable_description: "Ikke tilgjengelig",
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
