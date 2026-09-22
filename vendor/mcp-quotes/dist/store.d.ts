import type { ComputedLine, TaxLine } from "@theluckystrike/mcp-invoice/lib";
/**
 * Quotes live in this server's OWN data directory,
 * `${XDG_DATA_HOME:-~/.local/share}/mcp-servers/quotes/`. The invoices an accepted quote
 * turns into are written into the INVOICE server's directory through the shared engine
 * (@theluckystrike/mcp-invoice/lib), so they share one client list and one number series.
 *
 * Two directories, two locks, always taken in the same order (quotes, then invoice), the
 * same order servers/recurring uses, so no two processes in this repo can deadlock.
 *
 * Reads go through the invoice engine's `readJsonFile`, so a quotes.json that is not JSON
 * is quarantined byte-for-byte as `quotes.json.corrupt-<timestamp>` with a `.corrupt`
 * marker beside it, and every later call fails loudly instead of treating a store that is
 * still on disk as "no quotes".
 */
export type QuoteStatus = "open" | "accepted" | "declined";
export interface QuoteParty {
    name: string;
    address?: string;
    email?: string;
    vat_id?: string;
}
export interface Quote {
    /** `Q-<YYYY>-<NNNN>`, allocated per year. */
    id: string;
    client_id?: string;
    client: QuoteParty;
    issue_date: string;
    /** Last day the quote is good for, inclusive. */
    valid_until: string;
    validity_days: number;
    currency: string;
    decimals: number;
    lines: ComputedLine[];
    subtotal_minor: number;
    discount_percent: number;
    discount_minor: number;
    net_minor: number;
    tax_lines: TaxLine[];
    tax_minor: number;
    total_minor: number;
    notes?: string;
    status: QuoteStatus;
    accepted_date?: string;
    declined_date?: string;
    decline_reason?: string;
    /** Set when accepting created a real invoice in the invoice server. */
    invoice_number?: string;
    /** Day `quote_send_text` first handed the quote to the client. The client has seen it. */
    sent_date?: string;
    /** Where `quote_pdf` last wrote the rendered document. */
    exported_path?: string;
    created: string;
    updated: string;
    /** Free tier renders a footer credit on the PDF. */
    branded: boolean;
}
export declare function dataDir(): string;
export declare function lockPath(): string;
export declare function getQuotes(): Quote[];
export declare function setQuotes(q: Quote[]): void;
/**
 * Allocate the next quote id: `Q-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the quote is stored, so a crash burns an
 * id rather than reusing one. Ids already in the store are also scanned, so a restored or
 * hand-edited quotes.json can never hand back an id that is already on a document a
 * client has seen. The year is part of the id on purpose: a bare `Q-0001` reset every
 * January collides with last January's quote, and the two are different documents.
 */
export declare function nextQuoteId(year: string, existing: Quote[]): string;
/**
 * Resolve a quote by exact id (case-insensitive), then by exact client name, then -- only
 * if nothing exact matched -- by partial client name. More than one partial candidate is
 * refused with the list rather than silently picking the first, so quote_accept cannot
 * accept the wrong client's quote.
 */
export declare function findQuote(list: Quote[], ref: string): Quote | undefined;
/**
 * Is the invoice server's store actually in use on this machine? True when it already
 * holds invoices, a client list or a business profile. quote_accept uses this to decide
 * between creating the invoice directly and handing back invoice_create-ready items.
 */
export declare function invoiceStorePresent(): boolean;
