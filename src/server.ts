import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, BrowserContext, Page } from "playwright";
import { OdaClient } from "./oda-client.js";
import { CartItem } from "./types.js";
import fs from "fs";
import path from "path";

enum PageContext {
  CART = "cart",
  PRODUCT_SEARCH = "product_search",
  RECIPE_SEARCH = "recipe_search",
  RECIPE_INFO = "recipe_info",
}

export class OdaServer {
  private server: Server;
  private browser: BrowserContext | null = null;
  private page: Page | null = null;
  private detailPage: Page | null = null;
  private client: OdaClient | null = null;

  // State
  private cart: CartItem[] = [];
  private pageContext: PageContext = PageContext.CART;
  private validUrls: Set<string> = new Set();

  constructor(
    private dataDir: string,
    private headless: boolean = true,
  ) {
    this.server = new Server(
      {
        name: "mcp-oda",
        version: "1.0.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );

    this.setupHandlers();

    // Handle cleanup on exit
    process.on("SIGINT", async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: "oda://cart",
          name: "Shopping Cart",
          mimeType: "application/json",
          description: "Current shopping cart contents",
        },
        {
          uri: "oda://context",
          name: "Page Context",
          mimeType: "text/plain",
          description: "Current navigation context",
        },
      ],
    }));

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        if (request.params.uri === "oda://cart") {
          return {
            contents: [
              {
                uri: "oda://cart",
                mimeType: "application/json",
                text: JSON.stringify(this.cart, null, 2),
              },
            ],
          };
        }
        if (request.params.uri === "oda://context") {
          return {
            contents: [
              {
                uri: "oda://context",
                mimeType: "text/plain",
                text: this.pageContext,
              },
            ],
          };
        }
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Unknown resource: ${request.params.uri}`,
        );
      },
    );

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getTools(),
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (!this.client || !this.page || !this.detailPage) {
        throw new McpError(ErrorCode.InternalError, "Browser not initialized");
      }

      try {
        return await this.handleToolCall(
          request.params.name,
          request.params.arguments,
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        throw new McpError(ErrorCode.InternalError, msg);
      }
    });
  }

  private getTools(): Tool[] {
    return [
      {
        name: "cart_get_contents",
        description: "List all items currently in the shopping cart.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "cart_remove_item",
        description: "Remove an item from the cart using its index.",
        inputSchema: {
          type: "object",
          properties: { index: { type: "number" } },
          required: ["index"],
        },
      },
      {
        name: "products_search",
        description: "Search for products on Oda.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
      {
        name: "products_search_next",
        description: "Get the next page of search results.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "product_add_to_cart",
        description: "Add a product to the cart using its index.",
        inputSchema: {
          type: "object",
          properties: { index: { type: "number" } },
          required: ["index"],
        },
      },
      {
        name: "go_back",
        description: "Navigate back to a previously visited URL.",
        inputSchema: {
          type: "object",
          properties: { url: { type: "string" } },
          required: ["url"],
        },
      },
      {
        name: "recipes_search",
        description: "Search for recipes on Oda.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
      {
        name: "recipes_search_next",
        description: "Get the next page of recipe search results.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "recipes_search_filter",
        description: "Toggle filters on the recipe search page.",
        inputSchema: {
          type: "object",
          properties: {
            filter_ids: { type: "array", items: { type: "string" } },
          },
          required: ["filter_ids"],
        },
      },
      {
        name: "recipes_get_details",
        description: "Open a recipe to get detailed information.",
        inputSchema: {
          type: "object",
          properties: { index: { type: "number" } },
          required: ["index"],
        },
      },
      {
        name: "recipe_add_to_cart",
        description: "Add ingredients for the current recipe to the cart.",
        inputSchema: {
          type: "object",
          properties: { portions: { type: "number" } },
          required: ["portions"],
        },
      },
    ];
  }

  private async handleToolCall(name: string, args: any) {
    if (!this.client) throw new Error("Client not initialized");

    let result: any;
    switch (name) {
      case "cart_get_contents":
        this.cart = await this.client.getCartContents();
        this.pageContext = PageContext.CART;
        result = this.cart;
        break;

      case "cart_remove_item": {
        if (this.pageContext !== PageContext.CART)
          throw new Error("Context must be cart");
        const success = await this.client.removeFromCart(args.index);
        if (!success) throw new Error("Failed to remove item");
        this.fireAndForgetRefresh();
        result = "Item removed";
        break;
      }

      case "products_search": {
        const page = await this.client.searchProducts(args.query);
        this.validUrls.add(page.page_url);
        this.pageContext = PageContext.PRODUCT_SEARCH;
        result = page;
        break;
      }

      case "products_search_next": {
        if (this.pageContext !== PageContext.PRODUCT_SEARCH)
          throw new Error("Context must be product_search");
        const page = await this.client.searchNextPage();
        this.validUrls.add(page.page_url);
        result = page;
        break;
      }

      case "product_add_to_cart": {
        if (this.pageContext !== PageContext.PRODUCT_SEARCH)
          throw new Error("Context must be product_search");
        const success = await this.client.addToCart(args.index);
        if (!success) throw new Error("Failed to add product");
        this.fireAndForgetRefresh();
        result = "Product added";
        break;
      }

      case "go_back": {
        if (!this.validUrls.has(args.url)) throw new Error("Untrusted URL");
        await this.page!.goto(args.url);
        this.updateContextFromUrl(args.url);
        result = "Navigated back";
        break;
      }

      case "recipes_search": {
        const page = await this.client.searchRecipes(args.query);
        this.validUrls.add(page.page_url);
        this.pageContext = PageContext.RECIPE_SEARCH;
        result = page;
        break;
      }

      case "recipes_search_next": {
        if (this.pageContext !== PageContext.RECIPE_SEARCH)
          throw new Error("Context must be recipe_search");
        const page = await this.client.searchRecipesNext();
        this.validUrls.add(page.page_url);
        result = page;
        break;
      }

      case "recipes_search_filter": {
        if (this.pageContext !== PageContext.RECIPE_SEARCH)
          throw new Error("Context must be recipe_search");
        const page = await this.client.searchRecipesFilter(args.filter_ids);
        this.validUrls.add(page.page_url);
        result = page;
        break;
      }

      case "recipes_get_details": {
        const url = await this.client.getRecipeUrl(args.index);
        if (!url) throw new Error("Could not resolve recipe URL");
        await this.detailPage!.goto(url);
        // Need a client for detail page? Or can reuse logic?
        // The methods in OdaClient use `this.page`.
        // We can temporarily attach a client to detailPage or just use specific scraping logic.
        // OdaClient is stateful regarding `this.page`.
        // Let's create a temporary client for the detail page.
        const detailClient = new OdaClient(this.detailPage!);
        result = await detailClient.scrapeRecipeDetails();
        this.pageContext = PageContext.RECIPE_INFO;
        break;
      }

      case "recipe_add_to_cart": {
        if (this.pageContext !== PageContext.RECIPE_INFO)
          throw new Error("Context must be recipe_info");
        const detailClient = new OdaClient(this.detailPage!);
        const success = await detailClient.addCurrentRecipe(args.portions);
        if (!success) throw new Error("Failed to add recipe");
        this.fireAndForgetRefresh();
        result = "Recipe added";
        break;
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text:
            typeof result === "string"
              ? result
              : JSON.stringify(result, null, 2),
        },
      ],
    };
  }

  private updateContextFromUrl(url: string) {
    if (url.includes("/cart/")) this.pageContext = PageContext.CART;
    else if (url.includes("/search/products/"))
      this.pageContext = PageContext.PRODUCT_SEARCH;
    else if (url.includes("/recipes/all/"))
      this.pageContext = PageContext.RECIPE_SEARCH;
    else if (url.includes("/recipes/"))
      this.pageContext = PageContext.RECIPE_INFO;
  }

  private fireAndForgetRefresh() {
    this.refreshCart().catch(console.error);
  }

  private async refreshCart() {
    if (!this.browser) return;
    const page = await this.browser.newPage();
    try {
      const client = new OdaClient(page);
      this.cart = await client.getCartContents();
    } catch (e) {
      console.error("Background cart refresh failed", e);
    } finally {
      await page.close();
    }
  }

  async start() {
    // Setup browser
    fs.mkdirSync(this.dataDir, { recursive: true });

    this.browser = await chromium.launchPersistentContext(this.dataDir, {
      headless: this.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"], // Often needed in containers/linux
    });

    const cookiesPath = path.join(this.dataDir, "cookies.json");
    if (fs.existsSync(cookiesPath)) {
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf-8"));
      await this.browser.addCookies(cookies);
    }

    this.page = this.browser.pages()[0] || (await this.browser.newPage());
    this.detailPage = await this.browser.newPage();
    this.client = new OdaClient(this.page);

    // Initial cart load
    try {
      this.cart = await this.client.getCartContents();
    } catch (e) {
      console.warn("Initial cart load failed", e);
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MCP Oda Server running on stdio");
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  // Auth helper
  async auth(username?: string, password?: string) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    
    // If manual auth (no credentials), we MUST be headed.
    // If automated auth, we respect the class setting (default headless, but can be overridden).
    const headless = (username && password) ? this.headless : false;

    const browser = await chromium.launchPersistentContext(this.dataDir, {
      headless: headless,
    });
    const page = browser.pages()[0];

    if (username && password) {
        console.error("Attempting automated login...");
        const response = await page.goto("https://oda.com/no/user/login/");
        
        if (response?.status() === 425) {
             throw new Error("Server returned 425 Too Early. Please try again later.");
        }

        try {
            await page.waitForSelector('#email-input');
            await page.fill('#email-input', username);
            await page.fill('#password-input', password);
            
            // Use data-testid to ensure we click the login button and not a search button
            await page.click('[data-testid="submit-button"]');
            
            // Wait for navigation away from login page
            await page.waitForURL(url => !url.href.includes('/user/login/'), { timeout: 10000 }); 
            console.error("Login submitted. Verifying...");
            
            // Verify by going to account page
            await page.goto("https://oda.com/no/account/");
            const userName = await this.scrapeUserName(page);
            if (userName) {
                console.log(`Successfully logged in as: ${userName}`);
            } else {
                console.error("Login might have failed. Could not verify user name.");
            }
        } catch (e) {
            console.error("Automated login failed. Please check your credentials or try again.");
            if (this.headless === false) {
                console.error("Browser is open. You can check the state manually.");
                // Give user a moment to see what happened if headed
                await new Promise(r => setTimeout(r, 5000));
            }
        }
    } else {
        console.error("Opening browser for authentication...");
        console.error("Please log in to your Oda account.");
        console.error("Close the browser window when you're done logging in.");

        await page.goto("https://oda.com/no/account/");

        try {
          await page.waitForEvent("close", { timeout: 0 });
        } catch {
          console.error("Browser closed or interrupted");
        }
    }

    console.error("Saving session...");
    const cookies = await browser.cookies();
    fs.writeFileSync(
      path.join(this.dataDir, "cookies.json"),
      JSON.stringify(cookies),
    );
    console.error("Authentication completed. Session saved.");

    await browser.close();
  }

  async checkUser() {
      // Ephemeral browser for check
      const browser = await chromium.launchPersistentContext(this.dataDir, {
          headless: this.headless
      });
      const page = browser.pages()[0];
      
      // Load cookies
      const cookiesPath = path.join(this.dataDir, "cookies.json");
      if (fs.existsSync(cookiesPath)) {
        const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf-8"));
        await browser.addCookies(cookies);
      }

      try {
          await page.goto("https://oda.com/no/account/");
          if (page.url().includes("login")) {
              console.log("Not logged in.");
          } else {
              const userName = await this.scrapeUserName(page);
              if (userName) {
                  console.log(`Logged in as: ${userName}`);
              } else {
                  console.log("Logged in (could not determine name).");
              }
          }
      } catch (e) {
          console.error("Failed to check user:", e);
      } finally {
          await browser.close();
      }
  }

  private async scrapeUserName(page: Page): Promise<string | null> {
      try {
          // Based on: a[href="/no/account/"] > div > span.k-text-style--body-s
          // The header seems to have "Gudmundur Bjorn" in a specific span.
          // Let's try to find the user menu button content.
          // In the HTML provided:
          // <a href="/no/account/"> ... <span class="k-text-style k-text-style--body-s k-text--weight-regular">Gudmundur Bjorn</span> ... </a>
          const selector = 'a[href="/no/account/"] span.k-text-style--body-s.k-text--weight-regular';
          // Wait briefly
          await page.waitForSelector(selector, { timeout: 2000 });
          return await page.textContent(selector);
      } catch {
          return null;
      }
  }
}
