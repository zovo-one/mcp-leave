# Generate & send invoices from Claude with a free MCP server

**Listed on the [AI Product Index](https://index.percall.dev/l/zovo-invoice.html)** — live remote endpoint at [mcp.zovo.one/s/invoice](https://mcp.zovo.one/s/invoice), free tier, no signup.

**Featured on [Awesome MCP Servers](mcpservers.org)** — [directory listing](https://mcpservers.org/servers/github-com-theluckystrike-mcp-servers-tree-main-servers-invoice) | [live hosted endpoint](https://mcp.zovo.one/s/invoice), free tier, no signup.



Say "make an invoice for Acme, 12 hours at 90 EUR, due in 14 days" and get a real PDF you can send. This MCP server stores your business profile and your clients, allocates a sequential invoice number that is never reused, computes the subtotal, any discount, one tax line per VAT rate and the total in integer minor units, and renders an A4 PDF with your issuer and payment details, a wrapping item table and a proper totals block. It also tracks payments and, on Pro, reports what is overdue and by how many days. Everything is stored in plain JSON files on your own machine; nothing is uploaded anywhere.

In the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.theluckystrike%2Finvoice-pdf-billing-generator/versions/latest) (`io.github.theluckystrike/invoice-pdf-billing-generator`).

![invoice demo](../../assets/demo-invoice.gif)

Create numbered invoices with tax lines and a real PDF from chat, no invoicing SaaS required.

## 60-second install

npm publish for `@theluckystrike/mcp-invoice` is pending. Until then, the `.mcpb` one-click bundle or a clone+build
is the working path, both are verified below.

One-click (.mcpb): download `invoice.mcpb` from the latest release and double-click it in Claude Desktop:
https://github.com/theluckystrike/mcp-servers/releases/latest

(`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "invoice": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-invoice"]
    }
  }
}
```

Claude Code:

```sh
claude mcp add invoice -- npx -y @theluckystrike/mcp-invoice
```

(`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "invoice": {
      "command": "npx",
      "args": ["-y", "@theluckystrike/mcp-invoice"]
    }
  }
}
```

The `npx` form above starts working the moment the package is published. Until then, use the .mcpb bundle above, or
build from source with exactly these three commands:

```sh
git clone https://github.com/theluckystrike/mcp-servers.git && cd mcp-servers
npm install
npm run build -w packages/mcp-license -w servers/invoice
```

Then point your client's `command` at `node` with one arg: the absolute path to `servers/invoice/dist/index.js`.

To run in Pro mode set `MCP_LICENSE_KEY` in the same config block, or call `license_activate` once with your key.

## Tools

| Tool | What it does |
| --- | --- |
| `business_set` | Store the issuer profile: name, address, email, VAT id, IBAN, bank, logo, default currency, default tax rate, payment terms, invoice prefix. `tax_rate`, `vat_rate` and `vat` are accepted as aliases for `default_tax_rate`, and any unrecognised field is reported back rather than dropped |
| `client_add` | Add or update a client (name, address, email, VAT id). A record identical to one already stored is refused, naming the id that holds it, so the same client cannot be stored twice |
| `client_delete` | Delete a stored client nothing uses. Refused, with the document named, while an invoice, quote, credit note, purchase order, deposit, statement or recurring schedule still references it |
| `client_list` | List stored clients with their ids |
| `invoice_create` | Create an invoice from line items; allocates the next number, computes discount, tax per rate and total. Items may carry a per-line `currency`, and a mix is refused rather than billed as one currency. If the client is created from a bare name the response says the BILL TO block has no address and how to add one |
| `invoice_from_hours` | Shortcut: bill one client for N hours at an hourly rate. `target_currency` + `fx_rates` issue the invoice in another currency (you supply the rate); `entry_ids` come back with the new invoice number so the tracked hours can be closed with the time tracker's `entry_mark_billed` |
| `invoice_list` | List invoices, filtered by status, client and issue-date range |
| `invoice_get` | Full stored record for one invoice number |
| `invoice_mark_paid` | Record a payment in full or in part; reports the balance due |
| `invoice_pdf` | Render the A4 PDF and return the file path. The response calls the file a PDF only when it is one |
| `overdue_report` | Unpaid invoices past due, days overdue, outstanding totals per currency. Free |
| `license_status` | Show free or Pro mode |
| `license_activate` | Activate a Pro key (verified offline) |

Resource: `invoices://open` returns every unpaid or partly paid invoice as JSON.

Prompt: `monthly_invoicing` reviews what is unpaid and what is overdue for a month, then drafts the next invoice.

## What you can say

| You say | Tool |
| --- | --- |
| "Set up my business: Acme Consulting, EUR, 23% VAT, 14 day terms." | `business_set` |
| "Add a client: Beta Corp, their VAT id is..., email billing@beta.example." | `client_add` |
| "List my clients." | `client_list` |
| "Remove that duplicate Beta Corp client." | `client_delete` |
| "Invoice Acme for 12 hours at 90 EUR plus 300 EUR setup, 23% VAT, PDF." | `invoice_create` + `invoice_pdf` |
| "Bill Beta Corp for 5 hours at 120 EUR." | `invoice_from_hours` |
| "Show me every unpaid invoice from August." | `invoice_list` |
| "Pull up invoice INV-2026-0007." | `invoice_get` |
| "Mark INV-2026-0007 as paid in full." | `invoice_mark_paid` |
| "Which invoices are unpaid and overdue?" | `overdue_report` |
| "Am I on the free plan or Pro?" | `license_status` |

## Worked example

From `docs/USER_VALUE_R2.md`, the exact request tested end to end and independently checked against the
arithmetic.

```
You: Invoice Acme for 12 hours of API work at 90 EUR plus a 300 EUR setup fee,
23% VAT, due in 14 days, and give me the PDF.

  invoice_create {
    client: "Acme", currency: "EUR", due_days: 14,
    items: [
      { description: "API work",  quantity: 12, unit_price: 90,  tax_rate: 23 },
      { description: "Setup fee", quantity: 1,  unit_price: 300, tax_rate: 23 }
    ]
  }
  -> INV-2026-0001, client "Acme" created with no address on file

  invoice_pdf { number: "INV-2026-0001" }
  -> /Users/you/.../invoice/pdf/INV-2026-0001.pdf

Assistant: Created INV-2026-0001 for Acme.
  API work    12 h  x  EUR 90.00   =  EUR 1080.00
  Setup fee    1    x  EUR 300.00  =  EUR 300.00
  Subtotal                            EUR 1380.00
  Tax 23% on EUR 1380.00               EUR 317.40
  Total                                EUR 1697.40
Note: Acme was created from a bare name with no address. Add one with
client_add before you send this. PDF: INV-2026-0001.pdf
```

The arithmetic: 12 x 90 = 1080.00, plus 300.00 = 1380.00 subtotal; 23% of 1380.00 = 317.40; total
1697.40 EUR. Every amount on the PDF and in the text response carries its currency code, nothing is
ever shown as a bare number.

## Free vs Pro

| | Free | Pro |
| --- | --- | --- |
| Invoices | 3 per calendar month | Unlimited |
| `overdue_report` | Yes, unlimited | Yes, unlimited |
| PDF | Carries the line "Generated with mcp-invoice by theluckystrike" | No branding |
| Logo on the PDF | No | Yes |
| Custom invoice prefix | No, fixed `INV` | Yes |
| Clients, tax lines, discounts, payments, multi-currency | Yes | Yes |

Pro is a one-time $19, or $39 for every server in the collection, lifetime.

## Numbers and money

Invoice numbers are `PREFIX-YYYY-NNNN`. The counter is persisted per prefix and year and is written before the invoice is stored, so a crash burns a number rather than reusing one; existing numbers are also scanned so a restored data file can never hand back a number that is already on a sent document.

Every money value printed anywhere - line unit prices, line amounts, subtotal, discount, each tax line, the total and the balance due, in the text response and on the PDF - carries its currency code, for example `EUR 1080.00`. No amount is ever shown as a bare number.

All amounts are held as integer minor units. How many make one unit comes from an ISO 4217 table, not a guess: 2 for most currencies, 0 for JPY, KRW, VND, CLP, ISK and the rest of the zero-decimal list, 3 for BHD, IQD, JOD, KWD, LYD, OMR and TND, 4 for CLF and UYW. `KWD 1.234` is 1234 minor units, not 123. The table is identical to the one in [mcp-expense-tracker](../expense-tracker), because the two servers exchange amounts and a currency that is 3-decimal in one and 2-decimal in the other would rescale money by ten. HUF is 2 decimals: ISO 4217 gives it two minor digits even though it is usually quoted without them. Rounding is per line, then summed: each line's gross is rounded first, an invoice-level `discount_percent` is applied and rounded per line, tax is computed and rounded per line and then grouped into one line per rate, and the totals are plain integer sums of those already-rounded values. A printed total can therefore never disagree with the printed lines. Dates are ISO `YYYY-MM-DD`.

## How it stores data

Business profile, clients, invoices and the number counter live under
`${XDG_DATA_HOME:-~/.local/share}/mcp-servers/invoice/` as separate JSON files, plus a `pdf/` subfolder
holding the rendered PDFs. Every mutating call (`business_set`, `client_add`, `invoice_create`,
`invoice_from_hours`, `invoice_mark_paid`) runs inside `locked()`, which takes an advisory lock file at
`.../invoice/.lock` for the duration of the call, this is what makes number allocation safe when two
invoices are created in the same second, since the counter read, increment and invoice write all happen
under one lock. Saves go to a temporary file and are renamed into place. To back up your invoicing data,
copy the whole `invoice/` data directory, including `pdf/` if you want the rendered files too, they can
always be regenerated from the stored records with `invoice_pdf`.

If one of those JSON files is unreadable or not valid JSON, it is never treated as "empty". The file is
moved aside byte-for-byte as `<name>.json.corrupt-<timestamp>`, a `<name>.json.corrupt` marker is written,
and every tool returns `data file is corrupt; moved to ...; nothing was written` until you restore a good
copy and delete the marker. A truncated `clients.json` can no longer be silently replaced by an empty
client list.

## Limits and honest caveats

- Free tier allows 3 invoices per calendar month; the counter resets on the 1st. `overdue_report` and
  everything else (clients, tax lines, discounts, payments, multi-currency) is unrestricted on free.
- Clients are never metered: the client list is unlimited on free and on Pro. `client_add` still refuses a
  record identical to a stored one, and `client_delete` removes an unused client, so a mistyped or duplicated
  record can always be undone without a licence key. A client any document references cannot be deleted.
- Free PDFs carry a small "Generated with mcp-invoice" footer line; Pro removes it and adds a logo.
- Creating an invoice for a client name the server has never seen creates that client with no address;
  the response says so and names `client_add` as the fix, but nothing blocks you from sending a PDF with
  a bare-name BILL TO block if you ignore the note.
- This server skips email-sending, payment-link and accounting-software sync: it produces the PDF
  and the record; getting it to the client is up to you.
- Currency conversion is not performed anywhere, an invoice's currency is fixed at creation and every
  line must use amounts already in that currency.

## Troubleshooting

- **`npx` hangs or fails to find the package**: npm publish for this package is pending. Use the `.mcpb`
  bundle or the clone-and-build path above until it lands.
- **Using the `.mcpb` bundle**: it installs into Claude Desktop directly; there is no separate config
  step.
- **Using the clone path**: the server binary is `servers/invoice/dist/index.js` after `npm run build`.
  Point your client's `command` at `node` with that absolute path as the only argument.
- **Node version**: requires Node >= 18. Check with `node -v`.
- **Mixed currencies**: an item may carry its own `currency`. Every line on one invoice must agree with the invoice currency; a mix is refused and the message names the conversion call to make (`expense_to_invoice` with `target_currency` and `fx_rates`) rather than silently billing a EUR line under a USD heading. With no `currency` on the invoice, a single agreed item currency becomes the invoice's.
- **No business profile yet**: invoicing is never blocked by it. `invoice_create` and `invoice_from_hours`
  issue the document with the placeholder issuer "Your business" and say so in one line; run
  `business_set {name, address, vat_id, iban}` and render the PDF again to replace it.
- **PDF render fails or looks wrong**: `invoice_pdf` uses `pdfkit`, a pure-JS renderer with no native
  dependency, so failures are almost always a missing or malformed `business_set` field (check
  `invoice_get` first) rather than an environment issue.
- **"3 invoices this month" hit unexpectedly**: the free cap is per calendar month across all clients,
  not per client. `invoice_list` shows what already counted against it.
- **Nothing shows up / silent failures**: logs go to stderr only, never stdout. In Claude Desktop check
  Settings -> Developer -> the server's log file; in Claude Code check the terminal or `--mcp-debug`.

## Privacy

All data stays local, in `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/invoice/`. There are no network calls: license keys are verified offline with a public key compiled into the package, and PDFs are rendered on your machine.

## Pairs with

- [mcp-time-tracker](../time-tracker/README.md), `invoice_summary` output there maps directly onto `invoice_create` line items here.
- [mcp-spreadsheet](../spreadsheet/README.md), pull line items or client lists out of a sheet before invoicing.
- [mcp-price-tracker](../price-tracker/README.md), invoice a client for something you tracked the price of.
- [office-suite](../office-suite/README.md), every sibling server behind one install, one config entry.
- Guide: [Create an invoice PDF from a chat message with an MCP server](https://mcp.zovo.one/guides/invoice-pdf-from-chat)

## FAQ

Yes. Tax rate is per line item. The totals block prints one tax line per distinct rate, so a 23% line
and a 0% reverse-charge line appear separately and the total adds up.

It is a single page A4 with issuer and client blocks, dates, a line table with per-line tax, subtotal,
tax lines, total, and payment details with IBAN and reference. Add the client's address with `client_add`
first, otherwise BILL TO shows only the name.

`INV-YYYY-NNNN`, allocated in sequence and never reused. The prefix is configurable with `business_set`;
a prefix other than `INV` is a Pro feature.

No. Rendering is local with `pdfkit`, and the invoice records live in
`~/.local/share/mcp-servers/invoice/`. The server makes no network calls at all.

Amounts are integer minor units. Each line is rounded once, then lines are summed, so 12 h at 90 EUR
plus 300 EUR with 23% VAT gives 1380.00 plus 317.40 = 1697.40 with no floating point residue.

Built by [theluckystrike](https://github.com/theluckystrike).

## One business profile for the whole suite

Your identity is stored once, at `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/profile/business.json`,
and every server in the suite reads it: the invoice issuer, the docx letterhead, the recurring
issuer, expense-tracker's default VAT rate, time-tracker's and timezone's home zone, and the
resume and contract letterheads. Set it once with `business_set` (invoice or docx) - you never
repeat it anywhere else. An email address is only ever taken from that profile or from an explicit
argument; when none is stored, documents show `[add: email]` and the tool says so rather than
letting anyone improvise an address.

## Frequently asked questions

### Is there a free MCP server for invoices?

Yes. The invoice server at mcp.zovo.one is a free MCP server for invoices: create line-item invoices with tax and VAT lines from Claude or any MCP client, render a professional PDF, and track payment status. Three invoices per calendar month are free, no install required — you paste a hosted URL into your client.

### How do I generate an invoice from Claude?

Connect the hosted endpoint https://mcp.zovo.one/mcp/invoice (copy the tokenized URL from mcp.zovo.one/mcp/connect), then say: 'Invoice Acme for 12 hours at 90 EUR with 23% VAT, due in 14 days.' Claude creates the numbered invoice and returns a PDF.

## Use these docs as an MCP server

Any MCP client (Claude, Cursor, Windsurf, VS Code) can read this repository's documentation directly via GitMCP — no install:

- Docs MCP URL: https://gitmcp.io/theluckystrike/mcp-invoice
