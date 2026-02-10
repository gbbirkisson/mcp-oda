import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { OdaClient } from "./oda-client.js";
import fs from "fs";
import path from "path";

const { version } = createRequire(import.meta.url)("../package.json");

export class OdaServer {
  private mcpServer: McpServer;
  private client: OdaClient | null = null;
  private logPath: string;

  constructor(private dataDir: string) {
    this.logPath = path.join(dataDir, "mcp-oda.log");
    this.mcpServer = new McpServer({ name: "mcp-oda", version });
    this.registerTools();

    process.on("SIGINT", () => {
      process.exit(0);
    });
  }

  private getClient(): OdaClient {
    if (!this.client) throw new Error("Client not initialized");
    return this.client;
  }

  private logError(tool: string, args: unknown, error: unknown) {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const entry = JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "error",
        tool,
        args,
        error: error instanceof Error ? error.message : String(error),
      });
      fs.appendFileSync(this.logPath, entry + "\n");
    } catch {
      // Never let logging break the server
    }
  }

  private toolHandler<T>(name: string, fn: (args: T) => Promise<any>) {
    return async (args: T) => {
      try {
        return await fn(args);
      } catch (e) {
        this.logError(name, args, e);
        throw e;
      }
    };
  }

  private textResult(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }

  private jsonResult(data: unknown) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
  }

  private registerTools() {
    this.mcpServer.registerTool("check_login", {
      description: "Check if the user is logged in to Oda.",
    }, this.toolHandler("check_login", async () => {
      const userName = await this.getClient().checkUser();
      return this.jsonResult({ logged_in: !!userName });
    }));

    this.mcpServer.registerTool("cart_get_contents", {
      description: "Get the current shopping cart contents.",
    }, this.toolHandler("cart_get_contents", async () => {
      return this.jsonResult(await this.getClient().getCartContents());
    }));

    this.mcpServer.registerTool("cart_clear", {
      description: "Remove all items from the shopping cart.",
    }, this.toolHandler("cart_clear", async () => {
      await this.getClient().clearCart();
      return this.textResult("Cart cleared");
    }));

    this.mcpServer.registerTool("cart_remove_item", {
      description: "Remove a product from the cart by product ID.",
      inputSchema: { id: z.number(), count: z.number().optional() },
    }, this.toolHandler("cart_remove_item", async ({ id, count }) => {
      await this.getClient().removeFromCart(id, count);
      return this.textResult("Item removed");
    }));

    this.mcpServer.registerTool("products_search", {
      description: "Search for products on Oda.",
      inputSchema: { query: z.string(), page: z.number().optional() },
    }, this.toolHandler("products_search", async ({ query, page }) => {
      return this.jsonResult(await this.getClient().searchProducts(query, page));
    }));

    this.mcpServer.registerTool("product_add_to_cart", {
      description: "Add a product to the cart by product ID.",
      inputSchema: { id: z.number(), count: z.number().optional() },
    }, this.toolHandler("product_add_to_cart", async ({ id, count }) => {
      await this.getClient().addToCart(id, count);
      return this.textResult("Product added");
    }));

    this.mcpServer.registerTool("recipes_search", {
      description: "Search for recipes on Oda.",
      inputSchema: {
        query: z.string().optional(),
        page: z.number().optional(),
        filter_ids: z.array(z.string()).optional(),
      },
    }, this.toolHandler("recipes_search", async ({ query, page, filter_ids }) => {
      return this.jsonResult(await this.getClient().searchRecipes(query, page, filter_ids));
    }));

    this.mcpServer.registerTool("recipes_get_details", {
      description: "Get recipe details by recipe ID.",
      inputSchema: { id: z.number() },
    }, this.toolHandler("recipes_get_details", async ({ id }) => {
      return this.jsonResult(await this.getClient().getRecipeDetails(id));
    }));

    this.mcpServer.registerTool("recipe_add_to_cart", {
      description: "Add recipe ingredients to cart by recipe ID.",
      inputSchema: { id: z.number(), portions: z.number() },
    }, this.toolHandler("recipe_add_to_cart", async ({ id, portions }) => {
      await this.getClient().addRecipeToCart(id, portions);
      return this.textResult("Recipe added");
    }));

    this.mcpServer.registerTool("recipe_remove_from_cart", {
      description: "Remove a recipe and its ingredients from the cart by recipe ID.",
      inputSchema: { id: z.number() },
    }, this.toolHandler("recipe_remove_from_cart", async ({ id }) => {
      await this.getClient().removeRecipeFromCart(id);
      return this.textResult("Recipe removed");
    }));
  }

  async start() {
    fs.mkdirSync(this.dataDir, { recursive: true });

    const cookiePath = path.join(this.dataDir, "cookies.json");
    this.client = new OdaClient(cookiePath);

    const transport = new StdioServerTransport();
    await this.mcpServer.connect(transport);
    console.error("MCP Oda Server running on stdio");
  }

  // Auth helper
  async auth(username?: string, password?: string) {
    if (!username || !password) {
      console.error(
        "HTTP-based auth requires --user and --pass arguments.",
      );
      console.error(
        "Usage: mcp-oda auth login --user <email> --pass <password>",
      );
      process.exit(1);
    }

    fs.mkdirSync(this.dataDir, { recursive: true });
    const cookiePath = path.join(this.dataDir, "cookies.json");
    const client = new OdaClient(cookiePath);

    console.error("Attempting automated login...");
    const success = await client.login(username, password);

    if (success) {
      const userName = await client.checkUser();
      if (userName) {
        console.error(`Successfully logged in as: ${userName}`);
      } else {
        console.error("Login successful (could not determine name).");
      }
    } else {
      console.error(
        "Login failed. Please check your credentials.",
      );
      process.exit(1);
    }
  }

  async checkUser() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const cookiePath = path.join(this.dataDir, "cookies.json");
    const client = new OdaClient(cookiePath);

    try {
      const userName = await client.checkUser();
      if (userName) {
        console.error(`Logged in as: ${userName}`);
      } else {
        console.error("Not logged in.");
      }
    } catch (e) {
      console.error("Failed to check user:", e);
    }
  }
}
