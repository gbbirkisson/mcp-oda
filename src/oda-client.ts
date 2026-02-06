import { Page, Locator } from "playwright";
import { expect } from "@playwright/test";
import {
  SearchResult,
  ProductPage,
  CartItem,
  Recipe,
  RecipeFilter,
  RecipePage,
  RecipeDetail,
} from "./types.js";

class Parsers {
  static parsePrice(text: string | null): number {
    if (!text) return 0.0;
    try {
      // Remove currency, non-breaking spaces, regular spaces (thousands separator)
      const cleanText = text
        .replace(/kr/g, "")
        .replace(/\xa0/g, "")
        .replace(/ /g, "")
        .replace(/,/g, ".")
        .trim();
      return parseFloat(cleanText) || 0.0;
    } catch {
      return 0.0;
    }
  }

  static parseRelativePrice(text: string | null): [number, string] {
    if (!text) return [0.0, ""];
    try {
      // Format usually: "61,80 kr /l" or similar
      const parts = text
        .replace(/\xa0/g, " ")
        .replace(/\u2009/g, " ")
        .split("/");
      const pricePart = parts[0];
      const unitPart = parts.length > 1 ? "/" + parts[1].trim() : "";
      return [Parsers.parsePrice(pricePart), unitPart];
    } catch {
      return [0.0, ""];
    }
  }
}

class Selectors {
  // Cart
  static CART_TITLE = "Handlekurv – Oda";
  static CART_EMPTY_MSG = 'span:has-text("Du har ingen varer i handlekurven.")';
  static CART_CHECK_MSG =
    'span:has-text("Sjekk handlekurven før du går til kassen og betaler.")';
  static CART_ARTICLE = "article";
  static CART_ITEM_NAME = "h1";
  static CART_ITEM_SUBTITLE = ".styles_ProductInfoText__bDdwb span";
  static CART_ITEM_QUANTITY = "input[data-testid='cart-buttons-quantity']";
  static CART_ITEM_PRICE = ".k-text--weight-bold"; // Last one usually
  static CART_ITEM_REL_PRICE = ".k-text-color--subdued"; // Last one usually

  // Search
  static SEARCH_ARTICLE = "article";
  static SEARCH_ITEM_NAME = "p.k-text-style--title-xxs";
  static SEARCH_ITEM_SUBTITLE = "p.k-text-color--subdued"; // First one
  static SEARCH_ITEM_PRICE = "span.k-text--weight-bold.k-text-color--default";
  static SEARCH_ITEM_REL_PRICE = "p.k-text-color--subdued"; // Last one

  // Navigation
  static NEXT_PAGE = "Neste side";
  static PREV_PAGE = "Forrige side";

  // Actions
  static ADD_TO_CART_LABEL = "Legg til i handlekurven";
  static REMOVE_FROM_CART_LABEL = "Fjern fra handlekurven";

  // Recipes
  static RECIPE_GRID_LINK = 'a[href^="/no/recipes/"]';
  static FILTER_NAV = 'nav[aria-label="Liste over filtre"]';
  static FILTER_CATEGORY_CONTAINER = "div.k-py-2";
  static FILTER_LABEL = "label";
  static FILTER_CHECKBOX = "input[type='checkbox']";
  static FILTER_NAME = "span.k-text-style--body-m";
  static FILTER_COUNT = "span.k-pill";
  static RECIPE_PORTIONS_SELECT = "label:has-text('Porsjoner') ~ button";
  static RECIPE_ADD_TO_CART_BUTTON = "button[data-testid='add-to-cart-button']";
}

export class OdaClient {
  static BASE_URL = "https://oda.com/no";
  static API_CART_URL_PART = "tienda-web-api/v1/cart/items/";

  constructor(public page: Page) {}

  async getCartContents(): Promise<CartItem[]> {
    const response = await this.page.goto(`${OdaClient.BASE_URL}/cart/`);
    if (response?.status() === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    await expect(this.page).toHaveTitle(Selectors.CART_TITLE);

    // Wait for either cart items or empty/info message
    try {
      await Promise.race([
        this.page
          .getByText("Sjekk handlekurven før du går til kassen og betaler.")
          .waitFor({ timeout: 1000 }),
        this.page
          .getByText("Du har ingen varer i handlekurven.")
          .waitFor({ timeout: 1000 }),
        this.page.getByRole("article").first().waitFor({ timeout: 1000 }),
      ]);
    } catch {
      // Timeout waiting for cart state, proceeding
    }

    const articles = await this.page.getByRole("article").all();
    return Promise.all(
      articles.map((article, i) => this._extractCartItem(i, article)),
    );
  }

  private async _extractCartItem(
    index: number,
    article: Locator,
  ): Promise<CartItem> {
    const timeout = 2000;
    const nameTask = article
      .locator(Selectors.CART_ITEM_NAME)
      .textContent({ timeout })
      .catch(() => null);
    const subtitleTask = this._safeText(
      article.locator(Selectors.CART_ITEM_SUBTITLE).first(),
      timeout,
    );
    const quantityTask = article
      .getByTestId("cart-buttons-quantity")
      .getAttribute("value", { timeout })
      .catch(() => null);
    const priceTask = article
      .locator(Selectors.CART_ITEM_PRICE)
      .last()
      .textContent({ timeout })
      .catch(() => null);
    const relPriceTask = article
      .locator(Selectors.CART_ITEM_REL_PRICE)
      .last()
      .textContent({ timeout })
      .catch(() => null);

    const [name, subtitle, quantityStr, priceStr, relPriceStr] =
      await Promise.all([
        nameTask,
        subtitleTask,
        quantityTask,
        priceTask,
        relPriceTask,
      ]);

    const quantity = quantityStr ? parseInt(quantityStr, 10) : 0;
    const price = Parsers.parsePrice(priceStr);
    const [relPrice, relUnit] = Parsers.parseRelativePrice(relPriceStr);

    return {
      index,
      name: name?.trim() || "Unknown Product",
      subtitle: subtitle?.trim() || "",
      quantity,
      price,
      relative_price: relPrice,
      relative_price_unit: relUnit,
    };
  }

  async searchProducts(query: string): Promise<ProductPage> {
    const q = new URLSearchParams({ q: query });
    const response = await this.page.goto(`${OdaClient.BASE_URL}/search/products/?${q}`);
    if (response?.status() === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    await this.page.waitForLoadState("networkidle");
    return this._scrapeSearchResults();
  }

  async searchNextPage(): Promise<ProductPage> {
    const result = await this._navigate(
      Selectors.NEXT_PAGE,
      () => this._scrapeSearchResults(),
      () => this._getProductState(),
    );
    return result || { page_url: this.page.url(), items: [] };
  }

  async searchPreviousPage(): Promise<ProductPage> {
    const result = await this._navigate(
      Selectors.PREV_PAGE,
      () => this._scrapeSearchResults(),
      () => this._getProductState(),
    );
    return result || { page_url: this.page.url(), items: [] };
  }

  async searchRecipesNext(): Promise<RecipePage> {
    const result = await this._navigate(
      Selectors.NEXT_PAGE,
      () => this._scrapeRecipesPage(),
      () => this._getRecipeState(),
    );
    return result || { page_url: this.page.url(), filters: [], items: [] };
  }

  async searchRecipesPrevious(): Promise<RecipePage> {
    const result = await this._navigate(
      Selectors.PREV_PAGE,
      () => this._scrapeRecipesPage(),
      () => this._getRecipeState(),
    );
    return result || { page_url: this.page.url(), filters: [], items: [] };
  }

  private async _getProductState(): Promise<string> {
    const p = await this._scrapeSearchResults();
    return p.items.length > 0 ? p.items[0].name : "";
  }

  private async _getRecipeState(): Promise<string> {
    const p = await this._scrapeRecipesPage();
    return p.items.length > 0 ? p.items[0].name : "";
  }

  private async _navigate<T>(
    label: string,
    scraperFunc: () => Promise<T>,
    stateExtractor?: () => Promise<string>,
  ): Promise<T | null> {
    try {
      const button = this.page.getByLabel(label);
      if (await button.isVisible()) {
        let previousState = "";
        if (stateExtractor) {
          try {
            previousState = await stateExtractor();
          } catch {
            // ignore
          }
        }

        const currentUrl = this.page.url();
        await button.click();

        try {
          await this.page.waitForURL((u) => u.toString() !== currentUrl, {
            timeout: 5000,
          });
        } catch {
          // Proceed to network idle
        }

        await this.page.waitForLoadState("networkidle");

        if (stateExtractor && previousState) {
          try {
            const start = Date.now();
            while (Date.now() - start < 5000) {
              const currentState = await stateExtractor();
              if (currentState !== previousState) break;
              await new Promise((r) => setTimeout(r, 200));
            }
          } catch {
            // ignore
          }
        }

        await this.page.waitForTimeout(500);
        return await scraperFunc();
      }
    } catch (_e) {
      console.log(`Navigation button '${label}' not usable.`);
    }
    return null;
  }

  private async _scrapeSearchResults(): Promise<ProductPage> {
    interface ScrapedItem {
      name?: string | null;
      subtitle?: string | null;
      price?: string | null;
      rel_price?: string | null;
    }

    let items: ScrapedItem[] = [];
    try {
      items = await this.page.evaluate(
        ({ articleSelector, selectors }) => {
          const articles = document.querySelectorAll(articleSelector);
          return Array.from(articles).map((article) => {
            const relPrices = article.querySelectorAll(selectors.rel_price);
            const nameEl = article.querySelector(selectors.name) as HTMLElement;
            const subEl = article.querySelector(
              selectors.subtitle,
            ) as HTMLElement;
            const priceEl = article.querySelector(
              selectors.price,
            ) as HTMLElement;
            const relPriceEl =
              relPrices.length > 0
                ? (relPrices[relPrices.length - 1] as HTMLElement)
                : null;

            return {
              name: nameEl?.innerText,
              subtitle: subEl?.innerText,
              price: priceEl?.innerText,
              rel_price: relPriceEl?.innerText,
            };
          });
        },
        {
          articleSelector: Selectors.SEARCH_ARTICLE,
          selectors: {
            name: Selectors.SEARCH_ITEM_NAME,
            subtitle: Selectors.SEARCH_ITEM_SUBTITLE,
            price: Selectors.SEARCH_ITEM_PRICE,
            rel_price: Selectors.SEARCH_ITEM_REL_PRICE,
          },
        },
      );
    } catch (e) {
      console.warn("Failed to batch scrape search results", e);
      return { page_url: this.page.url(), items: [] };
    }

    const results: SearchResult[] = [];
    items.forEach((item) => {
      if (!item.name) return;
      const price = Parsers.parsePrice(item.price || null);
      const [relPrice, relUnit] = Parsers.parseRelativePrice(
        item.rel_price || null,
      );

      results.push({
        index: results.length,
        name: item.name.trim(),
        subtitle: item.subtitle?.trim() || "",
        price,
        relative_price: relPrice,
        relative_price_unit: relUnit,
      });
    });

    return { page_url: this.page.url(), items: results };
  }

  async searchRecipes(query?: string | null): Promise<RecipePage> {
    let url = `${OdaClient.BASE_URL}/recipes/all/`;
    if (query) {
      const q = new URLSearchParams({ q: query });
      url += `?${q}`;
    }
    const response = await this.page.goto(url);
    if (response?.status() === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    return this._scrapeRecipesPage();
  }

  private async _scrapeRecipesPage(): Promise<RecipePage> {
    const filters = await this._scrapeRecipeFilters();
    const recipes = await this._scrapeRecipes();
    return { page_url: this.page.url(), filters, items: recipes };
  }

  private async _scrapeRecipeFilters(): Promise<RecipeFilter[]> {
    const filters: RecipeFilter[] = [];
    const nav = this.page.locator(Selectors.FILTER_NAV);
    if (!(await nav.isVisible())) return [];

    const categoryContainers = await nav
      .locator(Selectors.FILTER_CATEGORY_CONTAINER)
      .all();
    for (const container of categoryContainers) {
      try {
        const titleEl = container.locator("span.k-text--weight-bold").first();
        if (!(await titleEl.isVisible())) continue;
        let category = await titleEl.textContent();
        category = category ? category.trim() : "Unknown";

        const labels = await container.locator(Selectors.FILTER_LABEL).all();
        for (const label of labels) {
          try {
            const inp = label.locator(Selectors.FILTER_CHECKBOX);
            const idAttr = await inp.getAttribute("id", { timeout: 100 });
            const nameEl = label.locator(Selectors.FILTER_NAME);
            const name = await nameEl.textContent({ timeout: 100 });
            const countEl = label.locator(Selectors.FILTER_COUNT);
            const countStr = (await countEl.isVisible())
              ? await countEl.textContent({ timeout: 100 })
              : "0";

            filters.push({
              id: idAttr || "",
              name: name ? name.trim() : "",
              count: countStr ? parseInt(countStr.trim(), 10) : 0,
              category,
            });
          } catch {
            // Skip
          }
        }
      } catch {
        // Skip
      }
    }
    return filters;
  }

  private _isValidRecipeUrl(url: string): boolean {
    const parts = url.replace(/^\//, "").replace(/\/$/, "").split("/");
    if (parts.length < 3) return false;
    if (parts[parts.length - 2] !== "recipes") return false;
    return /^\d/.test(parts[parts.length - 1]);
  }

  private async _scrapeRecipes(): Promise<Recipe[]> {
    interface ScrapedRecipe {
      url: string | null;
      text: string | null;
    }

    let items: ScrapedRecipe[] = [];
    try {
      items = await this.page.evaluate((selector) => {
        const elements = Array.from(document.querySelectorAll(selector));
        return elements.map((el) => ({
          url: el.getAttribute("href"),
          text: (el as HTMLElement).innerText,
        }));
      }, Selectors.RECIPE_GRID_LINK);
    } catch (e) {
      console.warn("Failed to batch scrape recipes", e);
      return [];
    }

    const recipes: Recipe[] = [];
    const seenUrls = new Set<string>();

    for (const item of items) {
      if (!item.url || seenUrls.has(item.url)) continue;
      if (!this._isValidRecipeUrl(item.url)) continue;

      seenUrls.add(item.url);
      const lines = (item.text || "")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l);
      const name = lines.length > 0 ? lines[0] : "Unknown Recipe";
      recipes.push({
        index: recipes.length,
        name,
      });
    }
    return recipes;
  }

  async searchRecipesFilter(filterIds: string[]): Promise<RecipePage> {
    for (const fid of filterIds) {
      try {
        const loc = this.page.locator(`input[id='${fid}']`);
        if (await loc.isVisible()) {
          await loc.click();
          await this.page.waitForLoadState("networkidle");
          await this.page.waitForTimeout(500);
        } else {
          console.warn(`Filter ${fid} not found.`);
        }
      } catch (e) {
        console.warn(`Failed to toggle filter ${fid}`, e);
      }
    }
    return this._scrapeRecipesPage();
  }

  async getRecipeUrl(index: number): Promise<string | null> {
    const links = await this.page.locator(Selectors.RECIPE_GRID_LINK).all();
    const seenUrls = new Set<string>();
    let validCount = 0;
    let targetUrl: string | null = null;

    for (const link of links) {
      const url = await link.getAttribute("href");
      if (!url || seenUrls.has(url)) continue;
      if (!this._isValidRecipeUrl(url)) continue;

      if (validCount === index) {
        targetUrl = url;
        break;
      }
      seenUrls.add(url);
      validCount++;
    }

    if (targetUrl) {
      return `${OdaClient.BASE_URL.replace("/no", "")}${targetUrl}`;
    }
    return null;
  }

  async openRecipeByIndex(index: number): Promise<RecipeDetail> {
    const fullUrl = await this.getRecipeUrl(index);
    if (!fullUrl) {
      throw new Error(`Could not resolve recipe index ${index} to a URL`);
    }
    const response = await this.page.goto(fullUrl);
    if (response?.status() === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    return this._parseRecipeJsonLd();
  }

  async scrapeRecipeDetails(): Promise<RecipeDetail> {
    return this._parseRecipeJsonLd();
  }

  private async _parseRecipeJsonLd(): Promise<RecipeDetail> {
    const jsonLdScripts = await this.page
      .locator('script[type="application/ld+json"]')
      .all();
    let recipeData: any = {};

    for (const script of jsonLdScripts) {
      const content = await script.textContent();
      if (!content) continue;
      try {
        const data = JSON.parse(content);
        const found = this._findRecipeInJsonLd(data);
        if (found) {
          recipeData = found;
          break;
        }
      } catch {
        // ignore
      }
    }

    if (Object.keys(recipeData).length === 0) {
      throw new Error("Could not find Recipe JSON-LD data on page");
    }

    return this._createRecipeDetail(recipeData);
  }

  private _findRecipeInJsonLd(data: any): any | null {
    if (typeof data === "object" && data["@type"] === "Recipe") return data;
    if (typeof data === "object" && Array.isArray(data["@graph"])) {
      for (const item of data["@graph"]) {
        if (item["@type"] === "Recipe") return item;
      }
    }
    return null;
  }

  private _createRecipeDetail(recipeData: any): RecipeDetail {
    let imageUrl: string | undefined = undefined;
    const image = recipeData.image;
    if (
      Array.isArray(image) &&
      image.length > 0 &&
      typeof image[0] === "string"
    ) {
      imageUrl = image[0];
    } else if (typeof image === "string") {
      imageUrl = image;
    }

    return {
      name: String(recipeData.name || "Unknown"),
      description: String(recipeData.description || ""),
      ingredients: (recipeData.recipeIngredient || []).map(String),
      instructions: (recipeData.recipeInstructions || []).map((step: any) =>
        typeof step === "object" ? step.text || "" : String(step),
      ),
      image_url: imageUrl,
    };
  }

  async addRecipeByIndex(index: number, portions: number): Promise<boolean> {
    const fullUrl = await this.getRecipeUrl(index);
    if (!fullUrl) {
      console.warn(`Could not resolve recipe index ${index} to a URL`);
      return false;
    }
    const response = await this.page.goto(fullUrl);
    if (response?.status() === 425) {
      throw new Error("Server returned 425 Too Early. Please try again later.");
    }
    return this.addCurrentRecipe(portions);
  }

  async addCurrentRecipe(portions: number): Promise<boolean> {
    try {
      const portionsSelector = this.page.locator(
        Selectors.RECIPE_PORTIONS_SELECT,
      );
      await expect(portionsSelector).toBeVisible({ timeout: 5000 });
    } catch {
      console.warn(`Could not verify recipe page loaded at ${this.page.url()}`);
      return false;
    }

    try {
      const portionsSelector = this.page.locator(
        Selectors.RECIPE_PORTIONS_SELECT,
      );
      const menuId = await portionsSelector.getAttribute("aria-controls");
      await portionsSelector.click();

      let option: Locator | null = null;
      if (menuId) {
        try {
          const menu = this.page.locator(`#${menuId}`);
          await expect(menu).toBeVisible({ timeout: 2000 });
          const potential = menu.getByText(String(portions), { exact: true });
          await expect(potential).toBeVisible({ timeout: 1000 });
          option = potential;
        } catch {
          option = null;
        }
      }

      if (!option) {
        option = this.page
          .getByText(String(portions), { exact: true })
          .locator("visible=true")
          .last();
      }

      await expect(option).toBeVisible({ timeout: 3000 });
      await option.click({ force: true });
      await this.page.waitForTimeout(100);
    } catch (e) {
      console.warn(`Failed to set portions to ${portions}`, e);
      return false;
    }

    try {
      const addButton = this.page.locator(Selectors.RECIPE_ADD_TO_CART_BUTTON);
      await expect(addButton).toBeEnabled();

      const responsePromise = this.page.waitForResponse(
        (r) =>
          r.url().includes(OdaClient.API_CART_URL_PART) &&
          [200, 201, 204, 425].includes(r.status()),
        { timeout: 5000 },
      );
      await addButton.click();
      const response = await responsePromise;
      if (response.status() === 425) {
        throw new Error("Server returned 425 Too Early. Please try again later.");
      }
      return true;
    } catch (e) {
      console.error("Failed to add recipe to cart", e);
      return false;
    }
  }

  async addToCart(index: number): Promise<boolean> {
    return this._modifyCart(index, Selectors.ADD_TO_CART_LABEL);
  }

  async removeFromCart(index: number): Promise<boolean> {
    return this._modifyCart(index, Selectors.REMOVE_FROM_CART_LABEL);
  }

  private async _modifyCart(index: number, label: string): Promise<boolean> {
    const articles = await this.page.getByRole("article").all();
    if (index >= articles.length) {
      console.warn(`Index ${index} out of bounds`);
      return false;
    }

    const article = articles[index];
    await article.scrollIntoViewIfNeeded();
    const button = article.getByLabel(label);

    try {
      await button.waitFor({ state: "visible", timeout: 1000 });
      await expect(button).toBeEnabled();
    } catch {
      console.warn(`Button '${label}' unavailable for item ${index}`);
      return false;
    }

    try {
      const responsePromise = this.page.waitForResponse(
        (r) =>
          r.url().includes(OdaClient.API_CART_URL_PART) &&
          [200, 201, 204, 425].includes(r.status()),
        { timeout: 2000 },
      );
      await button.click();
      const response = await responsePromise;
      if (response.status() === 425) {
        throw new Error("Server returned 425 Too Early. Please try again later.");
      }
      await this.page.waitForTimeout(100);
      return true;
    } catch (e) {
      if (e instanceof Error && e.message.includes("425")) throw e;
      console.error(`API interaction failed for '${label}'`, e);
      return false;
    }
  }

  private async _safeText(
    locator: Locator,
    timeoutMs: number = 30000,
  ): Promise<string> {
    try {
      return (await locator.textContent({ timeout: timeoutMs })) || "";
    } catch {
      return "";
    }
  }
}
