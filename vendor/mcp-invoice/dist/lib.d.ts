/**
 * The invoicing engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). Everything below it --
 * the money arithmetic, the date helpers, the PDF writer and the JSON store with its
 * numbering counter and corrupt-file quarantine -- is generic and is re-exported here so
 * a sibling server (servers/recurring) can create invoices in the SAME data directory,
 * under the same lock, with the same number series, without a second copy of the code.
 *
 * Nothing in this module touches the network or the licence store at import time.
 * `dataDir()` creates `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/invoice/` on first
 * call; `renderInvoicePdf` is the only async entry point.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-invoice/dist/*.js`
 * deep imports are not.
 */
export type { ComputedLine, InputItem, TaxLine, Totals } from "./money.js";
export { computeTotals, currencyDecimals, formatAmount, formatMoney, roundHalfUp, toMinor, } from "./money.js";
export { addDays, daysBetween, isoDate } from "./money.js";
export type { RenderOptions } from "./pdf.js";
export { renderInvoicePdf } from "./pdf.js";
export type { Business, Client, Invoice, Payment } from "./store.js";
export { CorruptDataError, DEFAULT_BUSINESS, creditedMinorFor, dataDir, findClient, getBusiness, getClients, getInvoices, hasBusiness, invoicesInMonth, markerPath, nextNumber, readJsonFile, setBusiness, setClients, setInvoices, } from "./store.js";
/**
 * The advisory lock file every mutation of the invoice data directory must be taken
 * under, including mutations made by another server in this repo. Pass it to
 * `withFileLock` from `@theluckystrike/mcp-license`. Two processes that lock different
 * paths do not exclude each other, so this path -- not a private one -- is what keeps
 * the number counter safe across servers.
 */
export declare function invoiceLockPath(): string;
