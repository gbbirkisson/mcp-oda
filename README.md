<h1>
  <p align="center">
    <a href="https://github.com/gbbirkisson/mcp-oda">
      <img src="mcp.svg" alt="Logo" height="128">
    </a>
    <br>mcp-oda
  </p>
</h1>

<p align="center">
  A Model Context Protocol (MCP) server for interacting with <a href="https://oda.com">oda.com</a>
</p>

If this project is just what you needed and/or has been helpful to you, please consider buying
me a coffee ☕

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/gbbirkisson)

<h2>Table of contents</h2>

<!-- vim-markdown-toc GFM -->

* [Features](#features)
* [Installation](#installation)
* [Usage](#usage)
  * [Initial Setup](#initial-setup)
  * [CLI Commands](#cli-commands)
  * [Configuration](#configuration)
    * [Claude Desktop](#claude-desktop)
    * [Claude Code](#claude-code)
    * [Gemini CLI](#gemini-cli)
* [Troubleshooting](#troubleshooting)
  * [Session not persisting](#session-not-persisting)

<!-- vim-markdown-toc -->

## Features

This MCP server provides tools to programmatically interact with Oda's grocery shopping platform:

- **Search products** - Search for groceries with support for Norwegian terms
- **Browse recipes** - Search, filter, and view recipe details
- **Manage shopping cart** - View cart contents, add/remove items, add recipe ingredients
- **CLI access** - All operations available as CLI subcommands in addition to MCP tools
- **Session persistence** - Maintains login session across restarts

## Installation

This project requires Node.js (v18+).

## Usage

### Initial Setup

Authenticate with your Oda account:

```bash
npx github:gbbirkisson/mcp-oda auth login --user your@email.com --pass yourpassword
```

Verify your login status:

```bash
npx github:gbbirkisson/mcp-oda auth user
```

> [!NOTE]
> Session data is stored by default in `~/.mcp-oda`

### CLI Commands

Running `npx github:gbbirkisson/mcp-oda` with no arguments prints help. The `mcp` subcommand
starts the MCP server. All other operations are available as subcommands:

```bash
# Start the MCP server
npx github:gbbirkisson/mcp-oda mcp

# Products
npx github:gbbirkisson/mcp-oda product search melk
npx github:gbbirkisson/mcp-oda product search melk --page 2
npx github:gbbirkisson/mcp-oda product add 132

# Cart
npx github:gbbirkisson/mcp-oda cart list
npx github:gbbirkisson/mcp-oda cart remove 132
npx github:gbbirkisson/mcp-oda cart clear

# Recipes
npx github:gbbirkisson/mcp-oda recipe search pizza
npx github:gbbirkisson/mcp-oda recipe details 123
npx github:gbbirkisson/mcp-oda recipe add 123 --portions 4
npx github:gbbirkisson/mcp-oda recipe remove 123

# Authentication
npx github:gbbirkisson/mcp-oda auth login --user your@email.com --pass yourpassword
npx github:gbbirkisson/mcp-oda auth logout
npx github:gbbirkisson/mcp-oda auth user

# Maintenance
npx github:gbbirkisson/mcp-oda clean
```

### Configuration

#### Claude Desktop
Claude Desktop configuration example:

```json
{
  "mcpServers": {
    "oda": {
      "command": "npx",
      "args": ["-y", "github:gbbirkisson/mcp-oda", "mcp"]
    }
  }
}
```

#### Claude Code

```bash
/plugin marketplace add gbbirkisson/mcp-oda
/plugin install mcp-oda@gbbirkisson/mcp-oda
```

#### Gemini CLI

```bash
gemini extensions install https://github.com/gbbirkisson/mcp-oda
```

## Troubleshooting

### Session not persisting

If your login session is not persisting between runs:

1. Try running with the `clean` subcommand to remove old session data:
   ```bash
   npx github:gbbirkisson/mcp-oda clean
   ```
2. Re-authenticate:
   ```bash
   npx github:gbbirkisson/mcp-oda auth login --user your@email.com --pass yourpassword
   ```
3. Make sure you're using the same `--data-dir` for all commands if you've overridden the default.
