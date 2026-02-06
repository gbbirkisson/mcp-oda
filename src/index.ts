#!/usr/bin/env node
import { Command } from "commander";
import { OdaServer } from "./server.js";
import path from "path";
import os from "os";
import fs from "fs";

const program = new Command();
const homeDir = os.homedir();
const defaultDataDir =
  process.env.MCP_ODA_DATA_DIR || path.join(homeDir, ".mcp-oda");

program
  .name("mcp-oda")
  .description("MCP server for Oda grocery store")
  .version("1.0.0")
  .option("--data-dir <path>", "Directory for browser data", defaultDataDir)
  .option(
    "--headed",
    "Run browser in headed mode (visible window)",
    process.env.MCP_ODA_HEADED === "true",
  );

program
  .action(async () => {
    const opts = program.opts();
    const server = new OdaServer(opts.dataDir, !opts.headed);
    await server.start();
  });

program
  .command("auth")
  .description("Run in auth mode to set up authentication")
  .option("--user <email>", "Email for automated login")
  .option("--pass <password>", "Password for automated login")
  .action(async (cmdOpts) => {
    const opts = program.opts();
    const server = new OdaServer(opts.dataDir, !opts.headed);
    await server.auth(cmdOpts.user, cmdOpts.pass);
  });

program
  .command("user")
  .description("Check current logged in user")
  .action(async () => {
      const opts = program.opts();
      const server = new OdaServer(opts.dataDir, !opts.headed);
      await server.checkUser();
  });

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

program.parse();

process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});
