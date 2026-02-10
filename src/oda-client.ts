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

export class OdaClient {
  static BASE_URL = "https://oda.com/no";
  static API_BASE = "https://oda.com";
  static CART_API = "https://oda.com/tienda-web-api/v1/cart/";
  static CART_ITEMS_API = "https://oda.com/tienda-web-api/v1/cart/items/";

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
    fs.writeFileSync(this.cookiePath, JSON.stringify(this.cookies, null, 2));
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

  private extractNextData(html: string): any | null {
    const match = html.match(
      /<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s,
    );
    if (!match) return null;
    try {
      return JSON.parse(match[1]);
    } catch {
      return null;
    }
  }

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
      throw new Error(
        "Server returned 425 Too Early. Please try again later.",
      );
    }
    const html = await response.text();
    return this.extractNextData(html);
  }

  async fetchJsonLd(url: string): Promise<any[]> {
    const response = await this.getFollowRedirects(url);
    if (response.status === 425) {
      throw new Error(
        "Server returned 425 Too Early. Please try again later.",
      );
    }
    const html = await response.text();
    return this.extractJsonLd(html);
  }

  /**
   * Find a specific query result from dehydrated React Query state.
   * The __NEXT_DATA__ contains queries keyed by queryKey arrays.
   */
  private findDehydratedQuery(nextData: any, keyPrefix: string): any | null {
    const queries =
      nextData?.props?.pageProps?.dehydratedState?.queries || [];
    for (const q of queries) {
      const key = q.queryKey;
      if (Array.isArray(key) && key[0] === keyPrefix) {
        return q.state?.data ?? null;
      }
    }
    return null;
  }

  // --- Dump helper (for CLI discovery) ---

  async dump(url: string): Promise<{
    nextData: any | null;
    jsonLd: any[];
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

    return {
      nextData: this.extractNextData(html),
      jsonLd: this.extractJsonLd(html),
      headers: responseHeaders,
      status: response.status,
      finalUrl: response.url,
    };
  }

  // --- Product methods ---

  async searchProducts(query: string, page = 1): Promise<ProductPage> {
    const url = `${OdaClient.BASE_URL}/search/products/?q=${encodeURIComponent(query)}${page > 1 ? `&page=${page}` : ""}`;
    const nextData = await this.fetchNextData(url);
    return this.parseProductPage(url, nextData);
  }

  private parseProductPage(url: string, nextData: any): ProductPage {
    if (!nextData) {
      return { page_url: url, items: [], has_more: false };
    }

    try {
      // Data is in dehydrated React Query state under "searchpageresponse"
      const data = this.findDehydratedQuery(nextData, "searchpageresponse");
      if (!data || !data.items) {
        return { page_url: url, items: [], has_more: false };
      }

      const has_more = data.attributes?.hasMoreItems === true;

      const items: SearchResult[] = [];

      for (const item of data.items) {
        if (item.type !== "product") continue;
        const a = item.attributes;
        if (!a) continue;

        const id = a.id || item.id;
        const name = a.fullName || a.name || "Unknown";
        const subtitle = a.nameExtra || "";
        const price = parseFloat(a.grossPrice) || 0;
        const unitPrice = parseFloat(a.grossUnitPrice) || 0;
        const unitPriceUnit = a.unitPriceQuantityAbbreviation || "";

        items.push({
          id,
          name,
          subtitle,
          price,
          relative_price: unitPrice,
          relative_price_unit: unitPriceUnit ? `/${unitPriceUnit}` : "",
        });
      }

      return { page_url: url, items, has_more };
    } catch (e) {
      console.error("Failed to parse product page", e);
      return { page_url: url, items: [], has_more: false };
    }
  }

  // --- Cart methods ---

  async getCartContents(): Promise<CartItem[]> {
    // Cart data is not in __NEXT_DATA__, use the REST API directly
    const response = await this.apiGet(OdaClient.CART_API);
    if (response.status === 425) {
      throw new Error(
        "Server returned 425 Too Early. Please try again later.",
      );
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
      const unitPriceUnit =
        product.unit_price_quantity_abbreviation || "";

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
    const response = await this.apiPost(
      OdaClient.CART_ITEMS_API,
      { items: [{ product_id: productId, quantity: count }] },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Add to cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`);
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
      throw new Error(`Remove from cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`);
    }
  }

  async clearCart(): Promise<void> {
    const response = await this.apiPost(
      `${OdaClient.API_BASE}/tienda-web-api/v1/cart/clear/`,
      {},
      `${OdaClient.BASE_URL}/cart/`,
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Clear cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`);
    }
  }

  // --- Recipe methods ---

  async searchRecipes(query?: string | null, page = 1, filterIds?: string[]): Promise<RecipePage> {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (page > 1) params.set("page", String(page));
    if (filterIds?.length) params.set("filters", filterIds.join(","));
    const qs = params.toString();
    const url = `${OdaClient.BASE_URL}/recipes/all/${qs ? `?${qs}` : ""}`;
    const nextData = await this.fetchNextData(url);
    return this.parseRecipePage(url, nextData);
  }

  private parseRecipePage(url: string, nextData: any): RecipePage {
    if (!nextData) {
      return { page_url: url, filters: [], items: [], has_more: false };
    }

    try {
      // Data is in dehydrated React Query state under "searchresponse"
      const data = this.findDehydratedQuery(nextData, "searchresponse");
      if (!data || !data.items) {
        return { page_url: url, filters: [], items: [], has_more: false };
      }

      const has_more = data.attributes?.hasMoreItems === true;

      // Filters: data.filters[] can be filtergroup or flat filter
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

      // Recipe items
      const items: Recipe[] = [];

      for (const item of data.items) {
        if (item.type !== "recipe") continue;
        const a = item.attributes;
        if (!a) continue;

        const recipeId = a.id || item.id;
        const name = a.title || "Unknown Recipe";
        const imageUrl = a.featureImageUrl || undefined;
        const duration = a.cookingDurationString || undefined;
        const difficulty = a.difficultyString || a.difficulty || undefined;

        items.push({
          id: recipeId,
          name,
          image_url: imageUrl,
          duration,
          difficulty,
        });
      }

      return { page_url: url, filters, items, has_more };
    } catch (e) {
      console.error("Failed to parse recipe page", e);
      return { page_url: url, filters: [], items: [], has_more: false };
    }
  }

  private async getRecipeData(recipeId: number): Promise<any> {
    const url = `${OdaClient.BASE_URL}/recipes/${recipeId}`;
    const nextData = await this.fetchNextData(url);
    if (!nextData) {
      throw new Error(`Could not load recipe page for ID ${recipeId}`);
    }
    const data = this.findDehydratedQuery(nextData, "get-recipe-detail");
    if (!data) {
      throw new Error(`Could not find recipe data for ID ${recipeId}`);
    }
    return data;
  }

  async getRecipeDetails(recipeId: number): Promise<RecipeDetail> {
    const data = await this.getRecipeData(recipeId);
    return this.createRecipeDetailFromApi(data);
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
    const instructions: string[] = (
      data.instructions?.instructions || []
    ).map((step: any) => step.text || "");

    return { name, description, ingredients, instructions, image_url: imageUrl };
  }

  async addRecipeToCart(
    recipeId: number,
    portions: number,
  ): Promise<void> {
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
      throw new Error(`Add recipe to cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`);
    }
  }

  async removeRecipeFromCart(recipeId: number): Promise<void> {
    const response = await this.apiPost(
      `${OdaClient.CART_ITEMS_API}?group_by=recipes`,
      { items: [{ recipe_id: recipeId, quantity: -1, delete: true }] },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Remove recipe from cart failed: HTTP ${response.status}${body ? ` – ${body.slice(0, 500)}` : ""}`);
    }
  }

  // --- Auth methods ---

  async login(email: string, password: string): Promise<boolean> {
    // First GET the login page to get CSRF token
    await this.getFollowRedirects(`${OdaClient.BASE_URL}/user/login/`);

    const response = await this.apiPost(
      `${OdaClient.API_BASE}/tienda-web-api/v1/user/login/`,
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
      const user = this.findDehydratedQuery(nextData, "user");
      if (user) {
        const name =
          `${user.firstName || ""} ${user.lastName || ""}`.trim();
        return name || user.email || null;
      }
    } catch {
      // ignore
    }
    return null;
  }
}
