<h1>
  <p align="center">
    <a href="https://github.com/gbbirkisson/mcp-oda">
      <img src="mcp.svg" alt="Logo" height="128">
    </a>
    <br>mcp-oda
  </p>
</h1>

<p align="center">
  A Model Context Protocol (MCP) server for interacting with [Oda.com](https://oda.com)
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
    * [Claude Code](#claude-code)
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

The easiest way to use mcp-oda is with [uvx](https://github.com/astral-sh/uv):

```bash
# Run directly from GitHub
uvx --from git+https://github.com/gbbirkisson/mcp-oda mcp-oda --help
```

## Usage

### Initial Setup

First, you need to authenticate with your Oda account:

```bash
# Open browser for authentication
uvx --from git+https://github.com/gbbirkisson/mcp-oda mcp-oda --auth

# The browser will open - log in to your Oda account
# Close the browser when done

# Verify you are still logged in
uvx --from git+https://github.com/gbbirkisson/mcp-oda mcp-oda --auth
```

### Configuration

#### Claude Desktop
Claude Desktop configuration example:

```json
{
  "mcpServers": {
    "oda": {
      "command": "uvx",
      "args": ["--from", "git+https://github.com/gbbirkisson/mcp-oda", "mcp-oda"]
    }
  }
}
```

#### Claude Code

```bash
claude mcp add oda -s user -- uvx --from git+https://github.com/gbbirkisson/mcp-oda mcp-oda
```

## Troubleshooting

### Session not persisting

If your login session is not persisting between runs:

1. Try running with `--clean` to remove old session data
2. Re-authenticate with `--auth`
3. Make sure you're using the same `--data-dir` for both auth and normal runs

### Browser issues

If you encounter browser-related issues:

```bash
# Clean browser data
uvx --from git+https://github.com/gbbirkisson/mcp-oda mcp-oda --clean

# Re-authenticate
uvx --from git+https://github.com/gbbirkisson/mcp-oda mcp-oda --auth
```
