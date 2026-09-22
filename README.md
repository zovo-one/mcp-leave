# mcp-leave

<!-- mirror-seo:start -->

**MCP server for a staff leave and PTO tracker: requests, approvals, balances, who is out and a calendar export.** Employee leave and PTO: balances, approvals, calendars, and who-is-out summaries.

Works with Claude Desktop, Claude Code, Cursor and any Model Context Protocol client. Runs on your own machine, or hosted with no install.

Product page: <https://mcp.zovo.one/s/leave> — what it does, the tools it exposes, and a live token endpoint.

## Install

**Hosted, nothing to install.** Get a token from <https://mcp.zovo.one/mcp/connect> (the connect page) or <https://mcp.zovo.one/mcp/token> (the same token as JSON); a free anonymous one is issued on the spot and a Pro key works the same way. Then point an MCP client at `https://mcp.zovo.one/mcp/leave` over streamable-http and send the token as `Authorization: Bearer <token>`.

If your client cannot set headers, put the token in the path instead: `https://mcp.zovo.one/mcp/leave/t/<token>`. Both forms work. The bare URL with no token answers 401 on `tools/call`, so the token is not optional.

**Claude Desktop, one click.** Download `leave.mcpb` from the [latest release](https://github.com/theluckystrike/mcp-servers/releases/latest) and double-click it.

**From source.** The mirror is self-contained: every `@theluckystrike/*` dependency is vendored, so a fresh clone builds with no extra setup.

```sh
git clone https://github.com/theluckystrike/mcp-leave.git
cd mcp-leave
npm install && npm run build
```

Then point your client at the built entry point:

```json
{
  "mcpServers": {
    "leave": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-leave/dist/index.js"]
    }
  }
}
```

> `@theluckystrike/mcp-leave` is **not published on npm yet**, so an `npx -y @theluckystrike/mcp-leave` command will fail. The three paths above are the working ones and each is exercised by CI.

![leave demo](https://raw.githubusercontent.com/theluckystrike/mcp-servers/main/assets/demo-leave.gif)

Read-only mirror of [mcp-servers/servers/leave](https://github.com/theluckystrike/mcp-servers/tree/main/servers/leave). See [MIRROR.md](MIRROR.md).

<!-- mirror-seo:end -->

[![theluckystrike/mcp-leave MCP server](https://glama.ai/mcp/servers/theluckystrike/mcp-leave/badges/score.svg)](https://glama.ai/mcp/servers/theluckystrike/mcp-leave)

**In the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.theluckystrike%2Fleave/versions/latest)** (`io.github.theluckystrike/leave`).
Employee leave/PTO tracking for solopreneurs and small studios: who is off,
when, and how many days each person has left. Add employees with an annual
allowance and any carried-over days, log vacation/sick/personal requests
(including half-days), approve or reject them, and read balances, conflicts
and who-is-out calendars directly from your MCP client — Claude Desktop,
Cursor, or any MCP host.

## Tools

- `"leave_employee_add"` — add an employee with `annualAllowance` (and optional `carriedOver`).
- `"leave_request"` — log a leave request (`employee`, `type`, `start`, `end`, optional `halfDay`, `reason`).
- `"leave_approve"` / `"leave_reject"` — decide a request; decisions are recorded with dates.
- `"leave_cancel"` — cancel a pending or approved request (keeps the audit trail).
- `"leave_balance"` — allowance, carried, approved, pending, committed and remaining days per employee.
- `"leave_out_range"` — who is out in a date range: day-by-day calendar rows plus person-days.
- `"leave_list"` — all employees and requests, filterable by employee and status.
- `"leave_import"` (Pro) — bulk-create requests from CSV; conflicting rows are rejected one by one, valid rows still apply.
- `"leave_export_ics"` (Pro) — export approved leave as an RFC5545 `.ics` calendar.

## The one rule that decides everything else

A day is committed when the request that spends it is **approved or pending**.
Balance is `allowance + carried − approved − pending`. Cancelling returns the
days immediately; rejecting never charged them.

Overlapping requests for the same person are refused at creation time — both
pending and approved count — so the calendar never contains two requests
claiming the same day.

## Free vs Pro

The free tier is the full CRUD surface: employees, requests, approvals,
balances, calendars — watermark-free, no request limits. Pro (an
`MCP_LICENSE_KEY`, activate with `"license_activate"`) adds bulk CSV import
and ICS calendar export. Run `"license_status"` to see the current tier.

## Quick start

```json
{
  "mcpServers": {
    "leave": { "command": "npx", "args": ["-y", "@theluckystrike/mcp-leave"] }
  }
}
```

Data lives in a single JSON store (`~/.mcp-leave/store.json`, or
`$XDG_DATA_HOME/mcp-servers/leave/store.json` when set), written atomically
under a file lock, so two clients on one machine never interleave writes.
