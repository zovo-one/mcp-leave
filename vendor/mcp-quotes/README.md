# mcp-quotes

Say "quote Acme for 12 hours at 90 EUR plus a 300 EUR setup, 23% VAT, good for 14 days" and get a numbered quote you can send today: the line table with VAT per rate, the total in integer minor units, a validity date computed in your own timezone, a plain-text version to paste straight into an email and, on Pro, the same A4 PDF layout your invoices use. When the client says yes, `quote_accept` turns it into a real invoice in the [mcp-invoice](../invoice) store, under the same client list and the same number series, with the numbers copied from the quote rather than recomputed. Everything is stored in plain JSON files on your own machine; nothing is uploaded anywhere.

**In the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.theluckystrike%2Fquotes-estimates-proposals-vat-win-rate/versions/latest)** (`io.github.theluckystrike/quotes-estimates-proposals-vat-win-rate`).

**Listed on the [AI Product Index](https://index.percall.dev/l/zovo-quotes.html)** — live remote endpoint at [mcp.zovo.one/s/quotes](https://mcp.zovo.one/s/quotes), free tier, no signup.


![quotes demo](../../assets/demo-quotes.gif)

Send a priced, VAT-correct quote from chat, and turn the yes into an invoice with one call.

## 60-second install

npm publish for `@theluckystrike/mcp-quotes` is pending. Until then, the `.mcpb` one-click bundle or a
clone+build is the working path.

One-click (.mcpb): download `quotes.mcpb` from the latest release and double-click it in Claude Desktop:
https://github.com/theluckystrike/mcp-servers/releases/latest

(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "quotes": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-quotes"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add quotes -- npx -y @theluckystrike/mcp-quotes
```

(`.cursor/mcp.json`): the same entry as Claude Desktop.

From source:

```sh
git clone https://github.com/theluckystrike/mcp-servers.git && cd mcp-servers
npm install
npm run build -w packages/mcp-license -w servers/invoice -w servers/quotes
```

Build `servers/invoice` first: the money, VAT, client and numbering engine is imported from it. Then point
your client's `command` at `node` with one arg, the absolute path to `servers/quotes/dist/index.js`.

To run in Pro mode set `MCP_LICENSE_KEY` in the same config block, or call `license_activate` once with your key.

## Tools

| Tool | What it does |
| --- | --- |
| `quote_create` | Quote a client: line items with quantity and unit price in minor units, VAT per line or the business default, an optional discount, a validity window. Allocates `Q-YYYY-NNNN` |
| `quote_list` | Every quote with client, total, validity and state: open, expired, accepted or declined. Filter by state, client or quote date |
| `quote_get` | The full stored record for one quote, including the invoice it became |
| `quote_update` | Revise a quote that is still open. Totals are recomputed; an accepted or declined quote is never edited |
| `quote_send_text` | A plain-text quote with the aligned line table, VAT lines, total and validity date, ready to paste into an email. Free |
| `quote_accept` | Mark it accepted and turn it into an invoice: created directly in the invoice server when its store is present, otherwise handed back as `invoice_create`-ready items |
| `quote_decline` | Mark it lost, with a reason, so it stops counting against the open quotes and lands in the win rate |
| `quote_delete` | Delete a draft quote nobody has seen yet and get its free open-quote slot back. Refused, with the dependent named, once it has been sent, accepted, invoiced or exported. Free |
| `quote_pdf` | Render the A4 PDF and return the path. Pro |
| `quote_report` | Open, accepted, declined and expired totals per currency, the value still open and the win rate. Free for the current calendar year to date |
| `license_status` | Show free or Pro mode |
| `license_activate` | Activate a Pro key (verified offline) |

Resource: `quotes://open` returns every quote still inside its validity window as JSON.

Prompt: `quote_followup` reviews what is open, what lapses soon and what already lapsed, then drafts the chase.

## What you can say

| You say | Tool |
| --- | --- |
| "Quote Acme for 12 hours at 90 EUR plus a 300 EUR setup, 23% VAT, good for 14 days." | `quote_create` |
| "Write that up as an email I can send." | `quote_send_text` |
| "Make Q-2026-0003 20 hours instead and give them another two weeks." | `quote_update` |
| "Acme said yes. Invoice it." | `quote_accept` |
| "Beta went with someone cheaper." | `quote_decline` |
| "I quoted Acme twice by mistake, drop the second one." | `quote_delete` |
| "What is still open, and what is my win rate?" | `quote_report` |
| "Which quotes have lapsed with no answer?" | `quote_list` with `state: "expired"` |

## Worked example

```
You: Quote Acme for 12 hours of API work at 90 EUR plus a 300 EUR setup fee,
23% VAT, good for 14 days.

  quote_create {
    client: "Acme", currency: "EUR", validity_days: 14,
    items: [
      { description: "API work",  quantity: 12, unit_price_minor: 9000,  tax_rate: 23 },
      { description: "Setup fee", quantity: 1,  unit_price_minor: 30000, tax_rate: 23 }
    ]
  }
  -> Q-2026-0001, valid until 2026-09-18

Assistant:
  API work    12  x  EUR 90.00   =  EUR 1080.00
  Setup fee    1  x  EUR 300.00  =  EUR 300.00
  Subtotal                          EUR 1380.00
  VAT 23% on EUR 1380.00             EUR 317.40
  TOTAL                              EUR 1697.40
  Valid until 2026-09-18.

You: They said yes.

  quote_accept { id: "Q-2026-0001" }
  -> accepted, invoice INV-2026-0004, due 2026-09-18, total EUR 1697.40
```

Prices go in as **minor units**: `9000` is EUR 90.00 and `150000` is JPY 150,000. There is no decimal
anywhere on the input side, so a price can never be entered ten times too small.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Open quotes | 5 at a time | Unlimited |
| `quote_send_text` (email-ready text) | Yes, unlimited | Yes, unlimited |
| Accept, decline, revise, VAT, discounts, multi-currency | Yes | Yes |
| `quote_delete` (drafts only) and the duplicate guard | Yes | Yes |
| `quote_pdf` | No | Yes |
| `quote_report` (pipeline and win rate) | Current calendar year to date | Any date range |
| PDF branding | n/a | No footer credit, and your logo |

The cap counts quotes that are still OPEN. Accepting, declining or letting one lapse frees the slot, so a
freelancer who closes their quotes never hits it. Two more things keep a slot from being wasted, both free:
`quote_create` refuses a quote identical to one already open and names the one you have, and `quote_delete`
removes a draft nobody has seen and gives the slot straight back.

Pro is a one-time $19, or $39 for every server in the collection, lifetime.

## One measured thing: why an accepted quote is copied, not recomputed

`quote_accept` writes the invoice from the quote's stored lines. The obvious alternative, recompute the
totals from the prices at acceptance time, was measured and rejected, because the VAT rate it would use is
the one in the shared business profile *today*, not the one the client was quoted.

Measured (`test/adversarial.test.mjs`, "a VAT rate change between quote and acceptance never moves the
agreed total"): a quote of EUR 1,000.00 net is issued with the profile's default rate of 23%, so the client
is given **EUR 1,230.00**. The profile's `default_tax_rate` is then changed to 8%, a rate change, a new
client class, a corrected setting, before the client answers. Recomputing at acceptance invoices
EUR 150.00 below the document they agreed to, on one quote, with nothing on either record
saying why they differ. Copying the stored lines invoices EUR 1,230.00 and the assertion holds
`tax_lines[0].rate === 23`.

The same rule is why the quote takes prices in minor units and refuses a decimal: the number on the quote
and the number on the invoice are the same integer, all the way through.

## Numbers, money and dates

Quote ids are `Q-YYYY-NNNN`. The counter is per year and is written before the quote is stored, so a crash
burns an id rather than reusing one, and existing ids are scanned as well, so a restored `quotes.json` can
never hand back an id that is already on a document a client has seen. The year is part of the id
deliberately: a bare `Q-0001` reset every January collides with last January's quote.

Money is integer minor units end to end, and how many make one unit comes from the ISO 4217 table in
[mcp-invoice](../invoice), 2 for most currencies, 0 for JPY, KRW, ISK and the rest, 3 for KWD and the
Gulf dinars, 4 for CLF and UYW. There is no second copy of that table, of the VAT arithmetic or of the money
formatter here: `computeTotals`, `currencyDecimals` and `formatMoney` are imported from
`@theluckystrike/mcp-invoice/lib`, so a quote and the invoice it becomes round identically, per line and
then summed. One quote is one currency; a mix across lines is refused rather than added up under whichever
heading came first.

Dates are ISO `YYYY-MM-DD`. "Today", and therefore whether a quote has expired, is computed in the
`timezone` of the shared business profile when one is set, not in the host machine's zone: a quote issued at
00:30 in Warsaw from a laptop still on US time would otherwise be dated the previous day and lapse a day
early.

## How it stores data

Quotes and the id counter live under `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/quotes/` as
`quotes.json` and `counter.json`, plus a `pdf/` subfolder for rendered files. Invoices created by
`quote_accept` are written into the invoice server's directory, `.../mcp-servers/invoice/`, so
`invoice_list` there shows them and they share one number series and one client list.

Every mutating call runs under an advisory lock directory at `.../quotes/.lock`; anything that writes an
invoice also takes `.../invoice/.lock`, always in that order (quotes, then invoice), the same order
`servers/recurring` uses, so two processes cannot deadlock. Saves go to a per-process temporary file and are
renamed into place. Measured: 40 quotes created by two processes against one data directory leave 40 quotes
and 40 unique ids (`test/concurrency.test.mjs`).

A store file that is not valid JSON is never treated as "no quotes". It is moved aside byte-for-byte as
`quotes.json.corrupt-<timestamp>`, a `.corrupt` marker is written beside it, and every later call, reads
included, fails with `restore a good copy ... then delete the marker` until a human resolves it.

## Limits and honest caveats

- The free tier holds 5 open quotes at a time. The text export, accepting, declining and revising are
  unrestricted on free, and the pipeline report answers free for the current calendar year to date; the PDF and a wider report range are Pro.
- Accepting writes the invoice through the shared engine, so the invoice server's own free cap of 3 invoices
  per calendar month is not applied to it. The quotes cap is the one that applies here, and the response
  says so.
- An expired quote is refused by `quote_accept` until you either extend it (`quote_update {valid_until}`) or
  say `allow_expired: true`. That is deliberate friction: a lapsed price should be re-confirmed.
- No email is sent. `quote_send_text` gives you the text and `quote_pdf` gives you the file; getting it to
  the client is up to you.
- No currency conversion. A quote's currency is fixed at creation and every line must already be in it.
- Accepting is one-way. There is no un-accept, because the invoice it created is a document with a number;
  cancel that invoice in the invoice server instead.

## Privacy

All data stays local: plain JSON files in your own data directory. No account, no API key, no network call
of any kind. License keys are verified offline.

Built by [theluckystrike](https://github.com/theluckystrike). Support: support@zovo.one

## Use these docs as an MCP server

Any MCP client (Claude, Cursor, Windsurf, VS Code) can read this repository's documentation directly via GitMCP — no install:

- Docs MCP URL: https://gitmcp.io/theluckystrike/mcp-quotes
