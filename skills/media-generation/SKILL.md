# ModelMax MCP Server

This repository contains the ModelMax MCP (Model Context Protocol) Server for media generation.

## Features

- `generate_image`: Generates an image using ModelMax.
- `generate_video`: Generates a video using ModelMax.
- `get_merchant_id`: Retrieves the ModelMax merchant ID.
- `check_balance`: Checks your current ModelMax API balance.

## Setup & Installation

1. Clone this repository or download the `scripts/` directory.
2. Navigate into the `scripts/` directory and install dependencies:
   ```bash
   cd scripts
   npm install
   ```
3. Add the MCP server to your Agent's configuration (e.g., using MCP CLI or OpenClaw config).
   ```bash
   mcp add modelmax-media "node /absolute/path/to/scripts/index.mjs"
   ```

## Configuration

Set the `MODELMAX_API_KEY` environment variable so the server can authenticate with the ModelMax API.
```bash
export MODELMAX_API_KEY="sk-xxxx"
```

If using a platform that supports automatic top-ups via Clink, you can enable auto-pay by setting:
```bash
export MODELMAX_AUTO_PAY="true"
```
