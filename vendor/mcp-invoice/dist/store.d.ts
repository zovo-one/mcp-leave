import type { ComputedLine, TaxLine } from "./money.js";
export interface Business {
    name: string;
    address?: string;
    email?: string;
    vat_id?: string;
    iban?: string;
    bank?: string;
    logo_path?: string;
    default_currency: string;
    default_tax_rate: number;
    payment_terms_days: number;
    invoice_prefix: string;
}
export interface Client {
    id: string;
    name: string;
    address?: string;
    email?: string;
    vat_id?: string;
    created: string;
}
export interface Payment {
    date: string;
    amount_minor: number;
    method?: string;
    reference?: string;
}
export interface Invoice {
    number: string;
    client_id: string;
    client: {
        name: string;
        address?: string;
        email?: string;
        vat_id?: string;
    };
    issue_date: string;
    due_date: string;
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
    rounding_drift_minor?: number;
    notes?: string;
    status: "unpaid" | "paid" | "partial";
    paid_date?: string;
    paid_minor: number;
    payments?: Payment[];
    created: string;
    branded: boolean;
}
export declare function dataDir(): string;
/**
 * Codex v3 #1 (P0). A read or JSON.parse failure must never be reported as "empty
 * database": the next mutation would then overwrite a history that is still on disk.
 * Only ENOENT means empty. A parse failure quarantines the file byte-for-byte as
 * <file>.corrupt-<timestamp>, writes a marker so every later call (read or write)
 * keeps failing until a human resolves it, and throws.
 */
export declare class CorruptDataError extends Error {
}
export declare function markerPath(file: string): string;
export declare function readJsonFile<T>(file: string, empty: T): T;
export declare const DEFAULT_BUSINESS: Business;
/**
 * D-R31. The issuer identity is one fact for the whole suite. The shared profile at
 * mcp-servers/profile/business.json is read first and wins field by field; the local
 * business.json is kept as the compatibility copy and as the fallback when no shared
 * profile exists yet. A field absent from the shared profile never blanks a local one.
 */
export declare function getBusiness(): Business;
/** Writes the shared profile as well, so docx, expense-tracker and recurring see it. */
export declare function setBusiness(b: Business): void;
export declare function hasBusiness(): boolean;
export declare function getClients(): Client[];
export declare function setClients(c: Client[]): void;
export declare function getInvoices(): Invoice[];
export declare function setInvoices(i: Invoice[]): void;
/**
 * Allocate the next invoice number: <prefix>-<YYYY>-<NNNN>.
 * The counter file is written before the invoice is stored, so a crash burns a number
 * rather than reusing one. Existing invoice numbers are also scanned so a restored or
 * hand-edited invoices.json can never hand back a number that is already on a document.
 */
export declare function nextNumber(prefix: string, year: string): string;
export declare function findClient(ref: string): Client | undefined;
export declare function invoicesInMonth(month: string): Invoice[];
/**
 * D-R96. `invoice_get`, `invoice_list` and `invoice_mark_paid` used to show a balance
 * computed from `total_minor - paid_minor` alone, with no idea a credit note existed
 * against the invoice - `statement-of-account` nets credit notes correctly (see
 * servers/statement-of-account/src/statement.ts `ageClient`), this store did not.
 *
 * This reads billing-docs' `credit-notes.json` directly rather than importing
 * `@theluckystrike/mcp-billing-docs/lib`: that package itself depends on
 * `@theluckystrike/mcp-invoice/lib` (for `readJsonFile`, `ComputedLine`, `TaxLine`), so a
 * static import back from here would be circular. Read-only, best-effort: a missing
 * billing-docs store (never installed), an unreadable one, or a row with the wrong shape
 * all degrade to "no credit for this invoice" rather than throwing - invoice_get must
 * still answer when billing-docs was never installed.
 *
 * A credit note's line totals are stored NEGATIVE (a credit note is a negative invoice),
 * so `total_minor` on each row is negative and is subtracted to get a positive credit,
 * mirroring the `-c.total_minor` in `ageClient`.
 */
export declare function creditedMinorFor(invoiceNumber: string, currency: string): number;
