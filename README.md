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
  * [Configuration](#configuration)
    * [Claude Desktop](#claude-desktop)
    * [Gemini CLI](#gemini-cli)
* [Troubleshooting](#troubleshooting)
  * [Session not persisting](#session-not-persisting)
  * [Browser issues](#browser-issues)

<!-- vim-markdown-toc -->

## Features

This MCP server provides tools to programmatically interact with Oda's grocery shopping platform:

- **Search products** - Search for groceries with support for Norwegian terms
- **Browse search results** - Navigate through paginated search results
- **Manage shopping cart** - View cart contents, add items, and remove items
- **Session persistence** - Maintains login session across restarts

## Installation

This project requires Node.js (v18+).

```bash
npx playwright install chromium
```

## Usage

### Initial Setup

First, you need to authenticate with your Oda account using the `auth` subcommand:

```bash
# Open browser for authentication
npx github:gbbirkisson/mcp-oda auth

# The browser will open - log in to your Oda account
# Close the browser when done
```

Alternatively, you can provide your credentials for automated login:

```bash
npx github:gbbirkisson/mcp-oda auth --user your@email.com --pass yourpassword
```

You can verify your login status using the `user` command:

```bash
npx github:gbbirkisson/mcp-oda user
```

> [!NOTE]
> Browser data is stored by default in `~/.mcp-oda`

### Configuration

#### Claude Desktop
Claude Desktop configuration example:

```json
{
  "mcpServers": {
    "oda": {
      "command": "npx",
      "args": ["-y", "github:gbbirkisson/mcp-oda"]
    }
  }
}
```
 #### Claude Code                                                                     │

```bash                                                                              │
/plugin marketplace add gbbirkisson/mcp-oda                                          │
/plugin install mcp-oda@mcp-oda                                                      │
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
2. Re-authenticate with `auth`:
   ```bash
   npx github:gbbirkisson/mcp-oda auth
   ```
3. Make sure you're using the same `--data-dir` for all commands if you've overridden the default.

### Browser issues

If you encounter browser-related issues, use the `clean` command and re-install playwright binaries:

```bash
# Clean browser data
npx github:gbbirkisson/mcp-oda clean

# Re-install browser
npx playwright install chromium

# Re-authenticate
npx github:gbbirkisson/mcp-oda auth
```
