# Installing mcp-leave (agent instructions)

This file tells an AI coding agent exactly how to install this MCP server. No account, no API key, no network service is required.

Server: **Leave** (@theluckystrike/mcp-leave)
What it does: Reusable leaves and the dated runs of them that somebody signs. A leave is a named list of steps, optionally grouped into sections, each one required or optional. A run is one pass of that leave against a job: every step is marked pass, fail or na, with who marked it, on what day, and a note saying what was found. `run_sign_off` puts a name and a date on it and freezes it. The central rule is that a run COPIES its leave's steps when it starts, so editing the leave afterwards never changes a run already under way and deleting the leave leaves its runs readable. `na` counts as answered and never as passed. No count is stored; every figure is derived on the call.
Source: https://github.com/theluckystrike/mcp-servers/tree/main/servers/leave
License: MIT. Support: support@zovo.one

## Status of the npm package

The npm package `@theluckystrike/mcp-leave` is not published yet. Until it is, the `npx` command below will fail with E404. Use **Alternative B - from source** further down, which is the supported path today, and keep the same client config with `"command": "node"` and the absolute path to `dist/index.js`. Everything else on this page is unchanged.

## Prerequisites

- Node.js 18 or newer on PATH (`node --version`).
- No native dependencies. The package is pure JavaScript.
- No sibling server is required at runtime. This one reads a single file it does not own, read-only and best-effort: the shared business profile (business name and address), which the invoice server's `business_set` writes. It is never written. No other store is opened; the job a run is against is named by its id and nothing more.

## Step 1 - the run command

```sh
npx -y @theluckystrike/mcp-leave
```

The server speaks MCP over stdio. It writes nothing to stdout except protocol traffic. Do not run it interactively as a check; the client starts it.

## Step 2 - write the client config

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS), `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "leave": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-leave"]
    }
  }
}
```

### Claude Code

```sh
claude mcp add leave -- npx -y @theluckystrike/mcp-leave
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project). Same entry as Claude Desktop.

## Alternative B - from source

```sh
git clone https://github.com/theluckystrike/mcp-servers
cd mcp-servers
npm install
npm run build --workspace @theluckystrike/mcp-leave
```

Then point the client at the built entry:

```json
{
  "mcpServers": {
    "leave": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-servers/servers/leave/dist/index.js"]
    }
  }
}
```

## Step 3 - the optional licence key

The free tier holds 3 leaves and runs them without limit, and answers everything else including the report text. A Pro key lifts the leave cap and lets `run_report` write a .txt file to `out_path`. Set it as `MCP_LICENSE_KEY` in the server's `env` block, or call `license_activate` once and it is stored in `~/.config/mcp-servers/license.json`.

```json
{
  "mcpServers": {
    "leave": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-leave"],
      "env": { "MCP_LICENSE_KEY": "MCPL1...." }
    }
  }
}
```

Keys are verified offline against a bundled public key. Nothing is sent anywhere.

## Step 4 - verify

Ask the assistant to call `license_status`. It answers with the tier and where the key came from. Then ask it to call `leave_create` with a name; a `CL-NNNN` id comes back. Add a step with `leave_item_add` and start a run with `run_start`.

## Where data lives

`${XDG_DATA_HOME:-~/.local/share}/mcp-servers/leave/`, as `templates.json`, `runs.json` and `counter.json`. Nothing else on the machine is written, except a report file when you pass `out_path`. There is no telemetry and no network call in this server.
