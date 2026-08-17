import {
  SearchResult,
  ProductPage,
  CartItem,
  Recipe,
  RecipeFilter,
  RecipePage,
  RecipeDetail,
} from "./types.js";
import fs from "fs";

/**
 * Find the end of the JSON array/object that starts at `start`, respecting
 * string literals and escapes, then parse that slice. Lets us pull a single
 * embedded JSON value out of a larger, non-JSON document.
 */
function parseJsonAt(text: string, start: number): any | null {
  const open = text[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === open) depth++;
    else if (c === close && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Concatenate the RSC flight payload, which Next.js streams to the browser as
 * a series of `self.__next_f.push([1, "<chunk>"])` calls. Chunks may split
 * anywhere - even mid-token - so they are only meaningful once joined.
 */
function collectFlightPayload(html: string): string {
  const re = /self\.__next_f\.push\(/g;
  let payload = "";
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    let i = m.index + m[0].length;
    while (i < html.length && /\s/.test(html[i])) i++;
    if (html[i] !== "[") continue;

    const arr = parseJsonAt(html, i);
    if (Array.isArray(arr) && arr[0] === 1 && typeof arr[1] === "string") {
      payload += arr[1];
    }
  }
  return payload;
}

/**
 * Collect React Query entries from every HydrationBoundary in the flight
 * payload. A page renders several boundaries (global chrome, page content),
 * each carrying its own `{"state":{"mutations":[],"queries":[...]}}`.
 */
function collectDehydratedQueries(flight: string): any[] {
  const re = /"queries"\s*:\s*\[/g;
  const queries: any[] = [];
  let m: RegExpExecArray | null;

  while ((m = re.exec(flight)) !== null) {
    const arr = parseJsonAt(flight, m.index + m[0].length - 1);
    if (!Array.isArray(arr)) continue;
    queries.push(
      ...arr.filter((q) => q && typeof q === "object" && "queryKey" in q),
    );
  }
  return queries;
}

/**
 * Pull the hydration data out of an Oda page.
 *
 * Oda has migrated from the Next.js Pages Router to the App Router: the
 * `__NEXT_DATA__` script tag is gone and React Query state now lives in the
 * RSC flight payload. Both layouts are normalised to the legacy
 * `props.pageProps.dehydratedState` shape so callers stay unchanged.
 */
export function extractNextData(html: string): any | null {
  const legacy = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (legacy) {
    try {
      return JSON.parse(legacy[1]);
    } catch {
      // Fall through to the App Router layout.
    }
  }

  const flight = collectFlightPayload(html);
  if (!flight) return null;

  const queries = collectDehydratedQueries(flight);
  if (queries.length === 0) return null;

  return { props: { pageProps: { dehydratedState: { queries } } } };
}

/**
 * Find a specific query result in dehydrated React Query state.
 * Supports both old string keys (key[0] === prefix) and new object
 * keys (key[0]._id === prefix).
 */
export function findDehydratedQuery(
  nextData: any,
  keyPrefix: string,
): any | null {
  const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];
  for (const q of queries) {
    const key = q.queryKey;
    if (!Array.isArray(key) || key.length === 0) continue;
    const first = key[0];
    if (
      first === keyPrefix ||
      (typeof first === "object" && first?._id === keyPrefix)
    ) {
      return q.state?.data ?? null;
    }
  }
  return null;
}

/** Render a React Query key as a readable name, for `dump` discovery output. */
export function describeQueryKey(key: any): string {
  const first = Array.isArray(key) ? key[0] : key;
  if (typeof first === "string") return first;
  if (first && typeof first === "object" && typeof first._id === "string") {
    return first._id;
  }
  return JSON.stringify(key);
}

/**
 * Locate a search payload, distinguishing "Oda changed their page structure"
 * from "this search legitimately matched nothing". Returning an empty list for
 * the former hides breakage until someone notices the tool has quietly stopped
 * working, so anything unrecognisable throws.
 */
function requireSearchData(
  url: string,
  nextData: any,
  kind: string,
  legacyKey: string,
): any {
  if (!nextData) {
    throw new Error(
      `Could not load page data from ${url} - the page returned no hydration state`,
    );
  }

  const data =
    findDehydratedQuery(nextData, "mixedSearch") ??
    findDehydratedQuery(nextData, legacyKey);

  if (!data || !Array.isArray(data.items)) {
    throw new Error(
      `Could not find ${kind} search results in page data from ${url} - Oda's page structure may have changed`,
    );
  }
  return data;
}

export function parseProductPage(url: string, nextData: any): ProductPage {
  const data = requireSearchData(url, nextData, "product", "searchpageresponse");
  const items: SearchResult[] = [];

  for (const item of data.items) {
    if (item.type !== "product") continue;
    const a = item.attributes;
    if (!a) continue;

    const unitPriceUnit = a.unitPriceQuantityAbbreviation || "";

    items.push({
      id: a.id || item.id,
      name: a.fullName || a.name || "Unknown",
      subtitle: a.nameExtra || "",
      price: parseFloat(a.grossPrice) || 0,
      relative_price: parseFloat(a.grossUnitPrice) || 0,
      relative_price_unit: unitPriceUnit ? `/${unitPriceUnit}` : "",
    });
  }

  return {
    page_url: url,
    items,
    has_more: data.attributes?.hasMoreItems === true,
  };
}

export function parseRecipePage(url: string, nextData: any): RecipePage {
  const data = requireSearchData(url, nextData, "recipe", "searchresponse");

  // Filters: data.filters[] can be a filtergroup or a flat filter
  const filters: RecipeFilter[] = [];
  for (const f of data.filters || []) {
    if (f.type === "filtergroup" && f.items) {
      const category = f.displayName || f.name || "Unknown";
      for (const opt of f.items) {
        filters.push({
          id: `${opt.name}:${opt.value}`,
          name: opt.displayValue || opt.value || "",
          count: opt.count || 0,
          category,
        });
      }
    } else if (f.type === "filter") {
      filters.push({
        id: `${f.name}:${f.value}`,
        name: f.displayValue || f.value || "",
        count: f.count || 0,
        category: "Filter",
      });
    }
  }

  const items: Recipe[] = [];
  for (const item of data.items) {
    if (item.type !== "recipe") continue;
    const a = item.attributes;
    if (!a) continue;

    items.push({
      id: a.id || item.id,
      name: a.title || "Unknown Recipe",
      image_url: a.featureImageUrl || undefined,
      duration: a.cookingDurationString || undefined,
      difficulty: a.difficultyString || a.difficulty || undefined,
    });
  }

  return {
    page_url: url,
    filters,
    items,
    has_more: data.attributes?.hasMoreItems === true,
  };
}

export class OdaClient {
  static BASE_URL = "https://oda.com/no";
  static API_BASE = "https://oda.com";
  static CART_API = "https://oda.com/api/v1/cart/";
  static CART_ITEMS_API = "https://oda.com/api/v1/cart/items/";

  private cookies: Record<string, string> = {};
  private readonly headers: Record<string, string>;

  constructor(private cookiePath: string) {
    this.headers = {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept-Language": "no,nb;q=0.9,en;q=0.8",
    };
    this.loadCookies();
  }

  // --- Cookie management ---

  private loadCookies() {
    try {
      if (!fs.existsSync(this.cookiePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.cookiePath, "utf-8"));

      if (Array.isArray(raw)) {
        // Playwright format: [{name, value, domain, ...}, ...]
        for (const c of raw) {
          if (c.name && c.value !== undefined) {
            this.cookies[c.name] = String(c.value);
          }
        }
      } else if (typeof raw === "object" && raw !== null) {
        // Simple format: {name: value, ...}
        for (const [k, v] of Object.entries(raw)) {
          this.cookies[k] = String(v);
        }
      }
    } catch {
      // Ignore corrupt cookie files
    }
  }

  saveCookies() {
    // Session cookies authenticate the Oda account; keep them private to the
    // local account even when the host's default umask is permissive.
    fs.writeFileSync(this.cookiePath, JSON.stringify(this.cookies, null, 2), {
      mode: 0o600,
    });
    fs.chmodSync(this.cookiePath, 0o600);
  }

  private updateCookies(response: Response) {
    const setCookies = response.headers.getSetCookie();
    for (const header of setCookies) {
      const parts = header.split(";")[0];
      const eq = parts.indexOf("=");
      if (eq > 0) {
        const name = parts.substring(0, eq).trim();
        const value = parts.substring(eq + 1).trim();
        this.cookies[name] = value;
      }
    }
  }

  private cookieHeader(): string {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  getCsrfToken(): string | null {
    return this.cookies["csrftoken"] || null;
  }

  // --- Core HTTP methods ---

  async get(url: string): Promise<Response> {
    const response = await fetch(url, {
      headers: {
        ...this.headers,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: this.cookieHeader(),
      },
      redirect: "manual",
    });
    this.updateCookies(response);
    return response;
  }

  async getFollowRedirects(url: string): Promise<Response> {
    const response = await fetch(url, {
      headers: {
        ...this.headers,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Cookie: this.cookieHeader(),
      },
      redirect: "follow",
    });
    this.updateCookies(response);
    return response;
  }

  private async apiPost(
    url: string,
    body: any,
    referer?: string,
  ): Promise<Response> {
    const csrf = this.getCsrfToken();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers,
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: this.cookieHeader(),
        Origin: OdaClient.API_BASE,
        Referer: referer || `${OdaClient.BASE_URL}/`,
        ...(csrf ? { "X-CSRFToken": csrf } : {}),
      },
      body: JSON.stringify(body),
      redirect: "manual",
    });
    this.updateCookies(response);
    return response;
  }

  private async apiGet(url: string): Promise<Response> {
    const csrf = this.getCsrfToken();
    const response = await fetch(url, {
      headers: {
        ...this.headers,
        Accept: "application/json",
        Cookie: this.cookieHeader(),
        Origin: OdaClient.API_BASE,
        Referer: `${OdaClient.BASE_URL}/`,
        ...(csrf ? { "X-CSRFToken": csrf } : {}),
      },
      redirect: "follow",
    });
    this.updateCookies(response);
    return response;
  }

  private async apiDelete(url: string): Promise<Response> {
    const csrf = this.getCsrfToken();
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        ...this.headers,
        Accept: "application/json",
        Cookie: this.cookieHeader(),
        Origin: OdaClient.API_BASE,
        Referer: `${OdaClient.BASE_URL}/cart/`,
        ...(csrf ? { "X-CSRFToken": csrf } : {}),
      },
      redirect: "manual",
    });
    this.updateCookies(response);
    return response;
  }

  // --- HTML parsing ---

  private extractJsonLd(html: string): any[] {
    const results: any[] = [];
    const regex = /<script type="application\/ld\+json">(.*?)<\/script>/gs;
    let m;
    while ((m = regex.exec(html)) !== null) {
      try {
        results.push(JSON.parse(m[1]));
      } catch {
        // skip malformed
      }
    }
    return results;
  }

  async fetchNextData(url: string): Promise<any | null> {
    const response = await this.getFollowRedirects(url);
    if (response.status === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    const html = await response.text();
    return extractNextData(html);
  }

  async fetchJsonLd(url: string): Promise<any[]> {
    const response = await this.getFollowRedirects(url);
    if (response.status === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    const html = await response.text();
    return this.extractJsonLd(html);
  }

  // --- Dump helper (for CLI discovery) ---

  async dump(url: string): Promise<{
    nextData: any | null;
    queryKeys: string[];
    headers: Record<string, string>;
    status: number;
    finalUrl: string;
  }> {
    const response = await this.getFollowRedirects(url);
    const html = await response.text();

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const nextData = extractNextData(html);
    const queries: any[] =
      nextData?.props?.pageProps?.dehydratedState?.queries ?? [];

    return {
      nextData,
      queryKeys: queries.map((q) => describeQueryKey(q.queryKey)),
      headers: responseHeaders,
      status: response.status,
      finalUrl: response.url,
    };
  }

  // --- Product methods ---

  async searchProducts(query: string, page = 1): Promise<ProductPage> {
    const url = `${OdaClient.BASE_URL}/search/products/?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;
    const nextData = await this.fetchNextData(url);
    return parseProductPage(url, nextData);
  }

  // --- Cart methods ---

  async getFrequentProducts(
    limit = 20,
    maxOrders = 30,
  ): Promise<
    Array<{
      id: number;
      name: string;
      times_ordered: number;
      total_quantity: number;
    }>
  > {
    let url: string | null = `${OdaClient.API_BASE}/api/v1/orders/`;
    const orderNumbers: string[] = [];

    // The order-list endpoint is paginated by date. Only request enough order
    // details to answer this explicit, read-only frequent-purchases query.
    while (url && orderNumbers.length < maxOrders) {
      const page = (await (await this.apiGet(url)).json()) as any;
      for (const month of page.results || []) {
        for (const order of month.orders || []) {
          if (order.order_number && orderNumbers.length < maxOrders) {
            orderNumbers.push(order.order_number);
          }
        }
      }
      url = page.has_more && page.get_more_url ? page.get_more_url : null;
    }

    const products = new Map<
      number,
      {
        id: number;
        name: string;
        times_ordered: number;
        total_quantity: number;
      }
    >();
    for (const orderNumber of orderNumbers) {
      const detail = (await (
        await this.apiGet(
          `${OdaClient.API_BASE}/api/v1/orders/${encodeURIComponent(orderNumber)}/`,
        )
      ).json()) as any;
      for (const group of detail.items?.item_groups || []) {
        for (const item of group.items || []) {
          if (!Number.isFinite(item.product_id) || !item.description) continue;
          const existing = products.get(item.product_id) || {
            id: item.product_id,
            name: item.description,
            times_ordered: 0,
            total_quantity: 0,
          };
          existing.times_ordered += 1;
          existing.total_quantity += Number(item.quantity) || 0;
          products.set(item.product_id, existing);
        }
      }
    }

    return [...products.values()]
      .sort(
        (a, b) =>
          b.times_ordered - a.times_ordered ||
          b.total_quantity - a.total_quantity ||
          a.name.localeCompare(b.name),
      )
      .slice(0, limit);
  }

  async getCartRecommendations(): Promise<unknown> {
    const response = await this.apiGet(
      `${OdaClient.API_BASE}/api/v1/cart/recommendations/`,
    );
    return response.json();
  }

  async getCartContents(): Promise<CartItem[]> {
    // Cart data is not in __NEXT_DATA__, use the REST API directly
    const response = await this.apiGet(OdaClient.CART_API);
    if (response.status === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    if (!response.ok) {
      return [];
    }

    try {
      const data = await response.json();
      return this.parseCartApi(data);
    } catch (e) {
      console.error("Failed to parse cart API response", e);
      return [];
    }
  }

  private parseCartApi(data: any): CartItem[] {
    const items: CartItem[] = [];

    // Items can be at top-level or nested under groups
    const rawItems: any[] = data.items || [];
    for (const group of data.groups || []) {
      rawItems.push(...(group.items || []));
    }

    for (const item of rawItems) {
      const product = item.product || {};
      const productId = product.id;
      const name = product.full_name || product.name || "Unknown Product";
      const subtitle = product.name_extra || "";
      const quantity = item.quantity || 1;
      const price = parseFloat(product.gross_price) || 0;
      const unitPrice = parseFloat(product.gross_unit_price) || 0;
      const unitPriceUnit = product.unit_price_quantity_abbreviation || "";

      items.push({
        id: productId,
        name,
        subtitle,
        quantity,
        price,
        relative_price: unitPrice,
        relative_price_unit: unitPriceUnit ? `/${unitPriceUnit}` : "",
      });
    }

    return items;
  }

  async addToCart(productId: number, count = 1): Promise<void> {
    const response = await this.apiPost(OdaClient.CART_ITEMS_API, {
      items: [{ product_id: productId, quantity: count }],
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Add to cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`,
      );
    }
  }

  async removeFromCart(productId: number, count = 1): Promise<void> {
    const response = await this.apiPost(
      OdaClient.CART_ITEMS_API,
      { items: [{ product_id: productId, quantity: -count }] },
      `${OdaClient.BASE_URL}/cart/`,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Remove from cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`,
      );
    }
  }

  async clearCart(): Promise<void> {
    const response = await this.apiPost(
      `${OdaClient.API_BASE}/api/v1/cart/clear/`,
      {},
      `${OdaClient.BASE_URL}/cart/`,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Clear cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`,
      );
    }
  }

  // --- Recipe methods ---

  async searchRecipes(
    query?: string | null,
    page = 1,
    filterIds?: string[],
  ): Promise<RecipePage> {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (page > 1) params.set("page", String(page));
    if (filterIds?.length) params.set("filters", filterIds.join(","));
    const qs = params.toString();
    const url = `${OdaClient.BASE_URL}/recipes/all/${qs ? `?${qs}` : ""}`;
    const nextData = await this.fetchNextData(url);
    return parseRecipePage(url, nextData);
  }

  private async getRecipeData(recipeId: number): Promise<any> {
    const url = `${OdaClient.BASE_URL}/recipes/${recipeId}`;
    const nextData = await this.fetchNextData(url);
    if (!nextData) {
      throw new Error(`Could not load recipe page for ID ${recipeId}`);
    }
    const data = findDehydratedQuery(nextData, "recipeDetailApi")
      ?? findDehydratedQuery(nextData, "get-recipe-detail");
    if (!data) {
      throw new Error(`Could not find recipe data for ID ${recipeId}`);
    }
    return data;
  }

  async getRecipeDetails(recipeId: number): Promise<RecipeDetail> {
    try {
      const data = await this.getRecipeData(recipeId);
      return this.createRecipeDetailFromApi(data);
    } catch {
      // Recipe pages are now also App Router pages. JSON-LD preserves the
      // public recipe detail needed for read-only lookups, but is deliberately
      // not used for cart mutation because it has no product IDs.
      const jsonLd = await this.fetchJsonLd(
        `${OdaClient.BASE_URL}/recipes/${recipeId}`,
      );
      const recipe = jsonLd.find((item) => item?.["@type"] === "Recipe");
      if (!recipe)
        throw new Error(`Could not load recipe page for ID ${recipeId}`);
      return {
        name: recipe.name || "Unknown",
        description: recipe.description || "",
        ingredients: recipe.recipeIngredient || [],
        instructions: (recipe.recipeInstructions || [])
          .map((step: any) =>
            typeof step === "string" ? step : step.text || "",
          )
          .filter(Boolean),
        image_url: Array.isArray(recipe.image) ? recipe.image[0] : recipe.image,
      };
    }
  }

  private createRecipeDetailFromApi(data: any): RecipeDetail {
    const name = data.title || "Unknown";
    const description = data.lead || "";
    const imageUrl = data.featureImageUrl || undefined;

    // Ingredients from ingredientsDisplayList
    const ingredients: string[] = (data.ingredientsDisplayList || []).map(
      (ing: any) => {
        const qty = parseFloat(ing.displayQuantity) || 0;
        const unit = ing.displayUnit || "";
        const title = ing.title || "";
        // Format as "250 g Mozzarella, fersk" or "1 stk Pizzabunn"
        const qtyStr = qty % 1 === 0 ? String(Math.round(qty)) : String(qty);
        return `${qtyStr} ${unit} ${title}`.trim();
      },
    );

    // Instructions
    const instructions: string[] = (data.instructions?.instructions || []).map(
      (step: any) => step.text || "",
    );

    return {
      name,
      description,
      ingredients,
      instructions,
      image_url: imageUrl,
    };
  }

  async addRecipeToCart(recipeId: number, portions: number): Promise<void> {
    const data = await this.getRecipeData(recipeId);
    const ingredients: any[] = data.ingredients || [];
    const items = ingredients
      .filter((ing: any) => ing.product?.id)
      .map((ing: any) => ({
        product_id: ing.product.id,
        quantity: (parseFloat(ing.portionQuantity) || 0) * portions,
        from_recipe_id: recipeId,
        from_recipe_portions: portions,
      }));

    const response = await this.apiPost(
      `${OdaClient.CART_ITEMS_API}?group_by=recipes`,
      { items },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Add recipe to cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`,
      );
    }
  }

  async removeRecipeFromCart(recipeId: number): Promise<void> {
    const response = await this.apiPost(
      `${OdaClient.CART_ITEMS_API}?group_by=recipes`,
      { items: [{ recipe_id: recipeId, quantity: -1, delete: true }] },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Remove recipe from cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`,
      );
    }
  }

  // --- Auth methods ---

  async login(email: string, password: string): Promise<boolean> {
    // First GET the login page to get CSRF token
    await this.getFollowRedirects(`${OdaClient.BASE_URL}/user/login/`);

    const response = await this.apiPost(
      `${OdaClient.API_BASE}/api/v1/user/login/`,
      { username: email, password },
      `${OdaClient.BASE_URL}/user/login/`,
    );

    if (response.ok) {
      this.saveCookies();
      return true;
    }

    return false;
  }

  async checkUser(): Promise<string | null> {
    // Use dehydrated query "user" from any page
    const nextData = await this.fetchNextData(`${OdaClient.BASE_URL}/cart/`);
    return this.extractUserName(nextData);
  }

  private extractUserName(nextData: any): string | null {
    if (!nextData) return null;
    try {
      const user = findDehydratedQuery(nextData, "user");
      if (user) {
        const name = `${user.firstName || ""} ${user.lastName || ""}`.trim();
        return name || user.email || null;
      }
    } catch {
      // ignore
    }
    return null;
  }
}
