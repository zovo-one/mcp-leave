/**
 * Money is handled in integer minor units (cents) everywhere inside this server.
 *
 * Rounding contract (documented, tested in test/money.test.mjs):
 *  1. The unit price is rounded into minor units FIRST, and the line is computed from
 *     that stored value, never from the unrounded input (D-R24):
 *       unit_i  = roundHalfUp(unit_price_i * 10^d)
 *       gross_i = roundHalfUp(quantity_i * unit_i)
 *     so unit_price_minor x quantity always equals gross_minor for a whole quantity, and
 *     the arithmetic printed on the invoice reproduces exactly: 10420 x 6 = 62520.
 *     The cost of this basis is that a converted line can sit one minor unit away from
 *     the mathematically exact conversion; the invoice adding up is worth more.
 *  2. An invoice level discount_percent is applied per line and rounded per line:
 *     discount_i = roundHalfUp(gross_i * p / 100); net_i = gross_i - discount_i.
 *  3. Tax is computed per line and rounded per line: tax_i = roundHalfUp(net_i * rate_i / 100),
 *     then summed into one tax line per distinct rate.
 *  4. Totals are plain integer sums of the already-rounded line values.
 * "Round per line, then sum" means a total can never drift from the printed lines by
 * more than the rounding already visible on those lines.
 */
export declare function currencyDecimals(currency: string): number;
/** Half-up rounding that is stable against binary floating point representation error. */
export declare function roundHalfUp(value: number): number;
/** Convert a major-unit amount (e.g. 90.5 EUR) into integer minor units. */
export declare function toMinor(amount: number, currency: string): number;
/** Render integer minor units as "EUR 1080.00" / "JPY 1080". */
export declare function formatMoney(minor: number, currency: string): string;
/** Render minor units without the currency code, for table columns. */
export declare function formatAmount(minor: number, currency: string): string;
export interface InputItem {
    description: string;
    quantity: number;
    unit_price: number;
    tax_rate?: number;
    round_total?: boolean;
}
export interface ComputedLine {
    description: string;
    quantity: number;
    unit_price_minor: number;
    tax_rate: number;
    gross_minor: number;
    discount_minor: number;
    net_minor: number;
    tax_minor: number;
    exact_gross_minor: number;
    round_total: boolean;
}
export interface TaxLine {
    rate: number;
    base_minor: number;
    tax_minor: number;
}
export interface Totals {
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
    rounding_drift_minor: number;
}
export declare function computeTotals(items: InputItem[], currency: string, discountPercent?: number, defaultTaxRate?: number): Totals;
/**
 * ISO date helpers. All dates stored and returned as YYYY-MM-DD.
 *
 * D-R15: this is the LOCAL calendar date, matching time-tracker's dayKey() and
 * expense-tracker's localDay(). It used to be `d.toISOString().slice(0,10)` (UTC), so in
 * UTC+7 an invoice issued at 06:36 local was stamped with the previous day while the
 * expense logged in the same conversation was stamped with the current one.
 */
export declare function isoDate(d?: Date): string;
export declare function addDays(iso: string, days: number): string;
export declare function daysBetween(fromIso: string, toIso: string): number;
