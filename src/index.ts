#!/usr/bin/env node
import { Command } from "commander";
import { OdaServer } from "./server.js";
import { OdaClient } from "./oda-client.js";
import path from "path";
import os from "os";
import fs from "fs";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");

const program = new Command();
const homeDir = os.homedir();
const defaultDataDir =
  process.env.MCP_ODA_DATA_DIR || path.join(homeDir, ".mcp-oda");

program
  .name("mcp-oda")
  .description("MCP server for Oda grocery store")
  .version(version)
  .option("--data-dir <path>", "Directory for session data", defaultDataDir);

// Helper: create an OdaClient from the data dir
function makeClient(): OdaClient {
  const opts = program.opts();
  const cookiePath = path.join(opts.dataDir, "cookies.json");
  return new OdaClient(cookiePath);
}

// Default action: print help
program.action(() => {
  program.help();
});

// --- mcp subcommand ---
program
  .command("mcp")
  .description("Start the MCP server")
  .action(async () => {
    const opts = program.opts();
    const server = new OdaServer(opts.dataDir);
    await server.start();
  });

// --- auth commands (unchanged) ---
const authCmd = program.command("auth").description("Authentication commands");

authCmd
  .command("login")
  .description("Log in with email and password")
  .option("--user <email>", "Email for login")
  .option("--pass <password>", "Password for login")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const server = new OdaServer(opts.dataDir);
    await server.auth(cmdOpts.user, cmdOpts.pass);
  });

authCmd
  .command("logout")
  .description("Log out and remove stored credentials")
  .action(() => {
    const opts = program.opts();
    const cookiePath = path.join(opts.dataDir, "cookies.json");
    if (fs.existsSync(cookiePath)) {
      fs.unlinkSync(cookiePath);
      console.error("Logged out. Removed credentials.");
    } else {
      console.error("Already logged out.");
    }
  });

authCmd
  .command("user")
  .description("Show current logged-in user")
  .action(async () => {
    const opts = program.opts();
    const server = new OdaServer(opts.dataDir);
    await server.checkUser();
  });

// --- product commands ---
const productCmd = program.command("product").description("Product commands");

productCmd
  .command("search <query>")
  .description("Search for products")
  .option("--page <number>", "Page number", "1")
  .action(async (query: string, cmdOpts) => {
    const client = makeClient();
    const result = await client.searchProducts(query, parseInt(cmdOpts.page));
    console.log(JSON.stringify(result, null, 2));
  });

productCmd
  .command("add <id>")
  .description("Add a product to the cart by ID")
  .option("--count <number>", "Quantity to add", "1")
  .action(async (id: string, cmdOpts) => {
    const client = makeClient();
    await client.addToCart(parseInt(id), parseInt(cmdOpts.count));
    console.log("Product added to cart.");
  });

// --- cart commands ---
const cartCmd = program.command("cart").description("Cart commands");

cartCmd
  .command("list")
  .description("List cart contents")
  .action(async () => {
    const client = makeClient();
    const result = await client.getCartContents();
    console.log(JSON.stringify(result, null, 2));
  });

cartCmd
  .command("remove <id>")
  .description("Remove a product from the cart by ID")
  .option("--count <number>", "Quantity to remove", "1")
  .action(async (id: string, cmdOpts) => {
    const client = makeClient();
    await client.removeFromCart(parseInt(id), parseInt(cmdOpts.count));
    console.log("Product removed from cart.");
  });

cartCmd
  .command("clear")
  .description("Clear the cart")
  .action(async () => {
    const client = makeClient();
    await client.clearCart();
    console.log("Cart cleared.");
  });

// --- recipe commands ---
const recipeCmd = program.command("recipe").description("Recipe commands");

recipeCmd
  .command("search [query]")
  .description("Search for recipes")
  .option("--page <number>", "Page number", "1")
  .option("--filter <ids...>", "Filter IDs")
  .action(async (query: string | undefined, cmdOpts) => {
    const client = makeClient();
    const result = await client.searchRecipes(
      query,
      parseInt(cmdOpts.page),
      cmdOpts.filter,
    );
    console.log(JSON.stringify(result, null, 2));
  });

recipeCmd
  .command("details <id>")
  .description("Get recipe details by ID")
  .action(async (id: string) => {
    const client = makeClient();
    const result = await client.getRecipeDetails(parseInt(id));
    console.log(JSON.stringify(result, null, 2));
  });

recipeCmd
  .command("add <id>")
  .description("Add recipe ingredients to cart")
  .requiredOption("--portions <number>", "Number of portions")
  .action(async (id: string, cmdOpts) => {
    const client = makeClient();
    await client.addRecipeToCart(parseInt(id), parseInt(cmdOpts.portions));
    console.log("Recipe added to cart.");
  });

recipeCmd
  .command("remove <id>")
  .description("Remove a recipe from the cart")
  .action(async (id: string) => {
    const client = makeClient();
    await client.removeRecipeFromCart(parseInt(id));
    console.log("Recipe removed from cart.");
  });

// --- logs command ---
program
  .command("logs")
  .description("Show error logs")
  .option("--clear", "Clear the log file")
  .action((cmdOpts) => {
    const opts = program.opts();
    const logPath = path.join(opts.dataDir, "mcp-oda.log");
    if (cmdOpts.clear) {
      if (fs.existsSync(logPath)) {
        fs.unlinkSync(logPath);
        console.error("Logs cleared.");
      } else {
        console.error("No logs found.");
      }
      return;
    }
    if (!fs.existsSync(logPath)) {
      console.error("No logs found.");
      return;
    }
    const content = fs.readFileSync(logPath, "utf-8");
    if (!content.trim()) {
      console.error("No logs found.");
      return;
    }
    process.stdout.write(content);
  });

// --- clean command (unchanged) ---
program
  .command("clean")
  .description("Remove the data directory")
  .action(() => {
    const opts = program.opts();
    const dataDir = opts.dataDir;
    if (fs.existsSync(dataDir)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      console.error(`Removed data directory: ${dataDir}`);
    } else {
      console.error(`Data directory does not exist: ${dataDir}`);
    }
  });

// --- dump command (unchanged) ---
program
  .command("dump <url>")
  .description("Fetch a URL and print __NEXT_DATA__ and JSON-LD content")
  .action(async (url: string) => {
    const client = makeClient();

    try {
      const result = await client.dump(url);

      console.log(`\n=== Response ===`);
      console.log(`Status: ${result.status}`);
      console.log(`Final URL: ${result.finalUrl}`);

      console.log(`\n=== Headers ===`);
      for (const [key, value] of Object.entries(result.headers)) {
        console.log(`${key}: ${value}`);
      }

      if (result.nextData) {
        console.log(`\n=== __NEXT_DATA__ ===`);
        console.log(JSON.stringify(result.nextData, null, 2));
      } else {
        console.log(`\n=== __NEXT_DATA__ ===`);
        console.log("(not found)");
      }

      if (result.jsonLd.length > 0) {
        console.log(`\n=== JSON-LD (${result.jsonLd.length} scripts) ===`);
        for (const [i, ld] of result.jsonLd.entries()) {
          console.log(`\n--- JSON-LD #${i} ---`);
          console.log(JSON.stringify(ld, null, 2));
        }
      } else {
        console.log(`\n=== JSON-LD ===`);
        console.log("(not found)");
      }
    } catch (e) {
      console.error("Dump failed:", e);
      process.exit(1);
    }
  });

program.parse();

process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});
