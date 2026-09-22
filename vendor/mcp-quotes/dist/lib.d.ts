/**
 * The quote store, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). What is re-exported
 * here is everything a sibling server would need to read or write quotes in the SAME
 * data directory, under the same lock and the same `Q-<YYYY>-<NNNN>` series: the record
 * type, the store accessors, the id allocator, the lock path, the A4 renderer and the
 * timezone-aware "today" the validity date is computed against.
 *
 * The money and VAT arithmetic is NOT re-exported: it lives in
 * `@theluckystrike/mcp-invoice/lib` and this server has no copy of it. Import
 * `computeTotals`, `formatMoney` and `currencyDecimals` from there.
 *
 * Nothing here touches the network or the licence store at import time.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-quotes/dist/*.js`
 * deep imports are not.
 */
export type { Quote, QuoteParty, QuoteStatus } from "./store.js";
export { dataDir, findQuote, getQuotes, invoiceStorePresent, lockPath, nextQuoteId, setQuotes, } from "./store.js";
export type { RenderQuoteOptions } from "./pdf.js";
export { renderQuotePdf } from "./pdf.js";
export { homeZone, isIsoDate, resetZoneCache, today } from "./day.js";
