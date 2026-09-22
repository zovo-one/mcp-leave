#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, withFileLock } from "@theluckystrike/mcp-license";
import { addDays, computeTotals, currencyDecimals, daysBetween, findClient, formatMoney, getBusiness, getClients, getInvoices, hasBusiness, invoiceLockPath, isoDate, nextNumber, setClients, setInvoices, } from "@theluckystrike/mcp-invoice/lib";
import { z } from "zod";
import { isIsoDate, today } from "./day.js";
import { renderQuotePdf } from "./pdf.js";
import { VERSION } from "./version.js";
import { dataDir, findQuote, getQuotes, invoiceStorePresent, lockPath, nextQuoteId, setQuotes, } from "./store.js";
/** Free tier: five quotes that are still open. Accepted, declined and expired ones never count. */
const FREE_OPEN_QUOTES = 5;
/**
 * D-R55: the pipeline report is a check the caller otherwise does by hand (and gets the
 * win-rate denominator wrong on: an unanswered quote is not a loss the client chose). It
 * is free for the current calendar year to date; Pro reports over any range.
 */
/** A quote a human reads is not a 1,000-line export. */
const MAX_ITEMS = 200;
/** Guard against 1e308 arriving as a price and producing an unrepresentable total. */
const MAX_MINOR = 1e12;
const DEFAULT_VALIDITY_DAYS = 30;
const MAX_VALIDITY_DAYS = 3650;
/** A quote is a document a human reads and a client is billed from, not a text dump. */
const MAX_CLIENT_NAME = 200;
const MAX_DESCRIPTION = 500;
const MAX_NOTES = 10000;
const MAX_ADDRESS = 2000;
const MAX_EMAIL = 320;
const MAX_VAT_ID = 64;
const gate = createLicenseGate({ product: "quotes" });
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const json = (v) => ok(JSON.stringify(v, null, 2));
/** A bounded free-text field: refused by name rather than silently truncated or stored whole. */
const text = (field, max, min = 0) => min > 0
    ? z.string().min(min, `${field} is required`).max(max, `${field} must be ${max} characters or fewer`)
    : z.string().max(max, `${field} must be ${max} characters or fewer`);
/**
 * Locks. Quote mutations take this server's lock. Anything that writes an INVOICE also
 * takes the invoice server's lock, because that is the lock its number counter is
 * allocated under. The order is always quotes -> invoice, in every path and the same
 * order servers/recurring uses, so two processes cannot deadlock against each other.
 */
function locked(fn) {
    return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}
function lockedWithInvoice(fn) {
    return withFileLock(lockPath(), () => withFileLock(invoiceLockPath(), fn, { timeoutMs: 20000 }), { timeoutMs: 20000 });
}
/**
 * The issuer block comes from the shared business profile, which `business_set` in the
 * invoice server writes. This server deliberately has no second copy of it, so one
 * identity prints on the quote and on the invoice it becomes. A missing profile never
 * blocks a quote: the document carries the placeholder issuer and the answer says so.
 */
const PLACEHOLDER_ISSUER = "Your business";
const NO_BUSINESS_NOTE = "No business profile yet: this quote shows a placeholder issuer. " +
    "Run business_set {name, address, vat_id, iban} in the invoice server (mcp-invoice) and render again.";
function businessMissing() {
    return !hasBusiness() || !getBusiness().name.trim();
}
function issuer() {
    const b = getBusiness();
    return b.name.trim() ? b : { ...b, name: PLACEHOLDER_ISSUER };
}
function expandPath(p) {
    const s = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
    return isAbsolute(s) ? s : resolvePath(process.cwd(), s);
}
/* --------------------------------------------------------------- validation */
const amount = (what) => z.number().finite().min(-MAX_MINOR, `${what} is out of range`).max(MAX_MINOR, `${what} is out of range`);
const itemSchema = z.object({
    description: z.string().min(1, "every line needs a description")
        .max(MAX_DESCRIPTION, `a line description must be ${MAX_DESCRIPTION} characters or fewer`)
        .describe(`every line needs a description, ${MAX_DESCRIPTION} characters or fewer`),
    quantity: amount("quantity").gt(0, "quantity must be greater than zero").describe("Hours or units, must be greater than zero"),
    unit_price_minor: z.number().int("unit_price_minor must be a whole number of minor units (cents), e.g. 9000 for 90.00 EUR")
        .min(0, "unit_price_minor cannot be negative").max(MAX_MINOR, "unit_price_minor is out of range")
        .describe("Price per unit in MINOR units: 9000 = 90.00 EUR, 90 = JPY 90. Never a decimal"),
    tax_rate: z.number().finite().min(0).max(1000).optional().describe("VAT percent for this line, overrides the business default"),
    currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional()
        .describe("Only to state the line's currency; every line on one quote must agree"),
});
/**
 * One currency per quote. A mix is refused rather than added up under whichever heading
 * came first: the invoice server refuses the same way, and a quote that silently billed
 * a USD line under a EUR total would be wrong on the document the client signs.
 */
function resolveCurrency(items, stated, fallback) {
    const stated3 = stated?.toUpperCase();
    const lineCurrencies = [...new Set(items.map((i) => i.currency?.toUpperCase()).filter(Boolean))];
    if (lineCurrencies.length > 1) {
        throw new Error(`the line items carry more than one currency (${lineCurrencies.join(", ")}). ` +
            `A quote is issued in ONE currency: convert the amounts yourself and pass every line in that currency.`);
    }
    const lineCurrency = lineCurrencies[0];
    if (stated3 && lineCurrency && stated3 !== lineCurrency) {
        throw new Error(`the quote currency is ${stated3} but a line item says ${lineCurrency}. ` +
            `Every line must be in the quote's currency; nothing was stored.`);
    }
    return stated3 ?? lineCurrency ?? fallback.toUpperCase();
}
/**
 * Totals come from the invoice engine's `computeTotals`, unchanged: same per-line
 * rounding, same one-tax-line-per-rate grouping, same integer arithmetic. This server
 * takes prices in MINOR units, and the engine takes major, so the price is divided by
 * 10^decimals on the way in. That round-trips exactly -- the engine multiplies by the
 * same power of ten and rounds half up, so an integer number of cents comes back as
 * itself -- and it is the reason there is no second copy of the VAT maths here.
 */
function totalsFor(items, currency, discountPercent, defaultTaxRate) {
    const f = Math.pow(10, currencyDecimals(currency));
    const engineItems = items.map((i) => ({
        description: i.description,
        quantity: i.quantity,
        unit_price: i.unit_price_minor / f,
        tax_rate: i.tax_rate,
    }));
    const t = computeTotals(engineItems, currency, discountPercent, defaultTaxRate);
    for (let i = 0; i < t.lines.length; i++) {
        if (t.lines[i].unit_price_minor !== items[i].unit_price_minor) {
            throw new Error(`line ${i + 1} (${items[i].description}) does not round-trip: ${items[i].unit_price_minor} minor units ` +
                `came back as ${t.lines[i].unit_price_minor}. Nothing was stored.`);
        }
    }
    if (!Number.isSafeInteger(t.total_minor) || !Number.isSafeInteger(t.subtotal_minor)) {
        throw new Error("that quote totals more than can be represented exactly in minor units. Nothing was stored.");
    }
    return t;
}
/* ------------------------------------------------------------------ display */
/** A quote is expired when it is still open and its last valid day is behind us. */
function isExpired(q, day) {
    return q.status === "open" && q.valid_until < day;
}
function stateOf(q, day) {
    return q.status === "open" ? (isExpired(q, day) ? "expired" : "open") : q.status;
}
function summarize(q, day) {
    return {
        id: q.id,
        client: q.client.name,
        issue_date: q.issue_date,
        valid_until: q.valid_until,
        state: stateOf(q, day),
        days_left: q.status === "open" ? daysBetween(day, q.valid_until) : undefined,
        currency: q.currency,
        total: formatMoney(q.total_minor, q.currency),
        total_minor: q.total_minor,
        invoice_number: q.invoice_number,
    };
}
function lineRows(q) {
    return q.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price: formatMoney(l.unit_price_minor, q.currency),
        unit_price_minor: l.unit_price_minor,
        tax_rate: `${l.tax_rate}%`,
        amount: formatMoney(l.gross_minor, q.currency),
    }));
}
function detail(q, day) {
    return {
        ...summarize(q, day),
        lines: lineRows(q),
        subtotal: formatMoney(q.subtotal_minor, q.currency),
        discount: q.discount_minor ? `${q.discount_percent}% = ${formatMoney(q.discount_minor, q.currency)}` : undefined,
        tax: q.tax_lines.filter((t) => t.rate || t.tax_minor)
            .map((t) => `${t.rate}% on ${formatMoney(t.base_minor, q.currency)} = ${formatMoney(t.tax_minor, q.currency)}`),
        notes: q.notes,
        accepted_date: q.accepted_date,
        declined_date: q.declined_date,
        decline_reason: q.decline_reason,
        created: q.created,
        updated: q.updated,
    };
}
/** The invoice_create payload for an accepted quote: major units, the engine's own shape. */
function invoiceItems(q) {
    const f = Math.pow(10, q.decimals);
    return q.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price: l.unit_price_minor / f,
        tax_rate: l.tax_rate,
    }));
}
function openCount(list, day) {
    return list.filter((q) => stateOf(q, day) === "open").length;
}
/**
 * The identity of a quote, for the duplicate guard: everything the client would read off
 * the document, normalised. Client name and line descriptions are trimmed and case-folded,
 * the currency is uppercased, money stays in minor units and the dates stay calendar
 * dates. Two open quotes with the same fingerprint are the same offer written twice: the
 * second one tells the reader nothing the first does not and costs a free open slot, which
 * before this guard there was no way to get back.
 */
function quoteFingerprint(q) {
    const fold = (v) => String(v ?? "").trim().toLowerCase();
    return JSON.stringify([
        fold(q.client.name), q.currency.toUpperCase(), q.issue_date, q.valid_until,
        q.discount_percent, q.total_minor, fold(q.notes),
        q.lines.map((l) => [fold(l.description), l.quantity, l.unit_price_minor, l.tax_rate]),
    ]);
}
/** The rendered document for a quote, if one is still on disk. */
function exportedPdf(q) {
    if (q.exported_path && existsSync(q.exported_path))
        return q.exported_path;
    const fallback = join(dataDir(), "pdf", `${q.id}.pdf`);
    return existsSync(fallback) ? fallback : undefined;
}
/**
 * What already depends on this quote, named. A quote with nothing in this list is a draft
 * nobody outside this machine has seen, so deleting it destroys no record; a quote with
 * anything in it is a document someone is holding, and quote_delete refuses rather than
 * leaving an invoice, a win-rate row or a PDF pointing at a quote that no longer exists.
 */
function dependentsOf(q) {
    const out = [];
    if (q.status === "accepted")
        out.push(`the acceptance recorded on ${q.accepted_date}`);
    if (q.invoice_number)
        out.push(`invoice ${q.invoice_number} in the invoice server`);
    if (q.status === "declined") {
        out.push(`the decline recorded on ${q.declined_date}${q.decline_reason ? ` (${q.decline_reason})` : ""}, ` +
            `which quote_report counts in the win rate`);
    }
    if (q.sent_date)
        out.push(`the copy sent to ${q.client.name} on ${q.sent_date}`);
    const pdf = exportedPdf(q);
    if (pdf)
        out.push(`the exported document at ${pdf}`);
    return out;
}
/* ----------------------------------------------------------- quote to invoice */
/**
 * Write the accepted quote into the INVOICE server's store as a real invoice: same
 * clients.json, same `PREFIX-YYYY-NNNN` counter, same JSON files `invoice_list` reads.
 * Must be called under lockedWithInvoice().
 *
 * The stored totals are copied line for line rather than recomputed. The client agreed to
 * the numbers on the quote; recomputing them from a rounded unit price is how a signed
 * document and its invoice come to differ by a cent.
 */
function issueInvoiceFromQuote(q, dueDays, issue) {
    const biz = issuer();
    let client = q.client_id ? getClients().find((c) => c.id === q.client_id) : undefined;
    if (!client)
        client = findClient(q.client.name);
    if (!client) {
        const clients = getClients();
        const c = {
            id: randomBytes(4).toString("hex"), name: q.client.name.trim(),
            address: q.client.address, email: q.client.email, vat_id: q.client.vat_id,
            created: isoDate(),
        };
        clients.push(c);
        setClients(clients);
        client = c;
    }
    const number = nextNumber(biz.invoice_prefix, issue.slice(0, 4));
    const inv = {
        number,
        client_id: client.id,
        client: { name: client.name, address: client.address, email: client.email, vat_id: client.vat_id },
        issue_date: issue,
        due_date: addDays(issue, dueDays ?? biz.payment_terms_days),
        currency: q.currency,
        decimals: q.decimals,
        lines: q.lines,
        subtotal_minor: q.subtotal_minor,
        discount_percent: q.discount_percent,
        discount_minor: q.discount_minor,
        net_minor: q.net_minor,
        tax_lines: q.tax_lines,
        tax_minor: q.tax_minor,
        total_minor: q.total_minor,
        notes: [q.notes, `Per accepted quote ${q.id} of ${q.issue_date}.`].filter(Boolean).join("\n"),
        status: "unpaid",
        paid_minor: 0,
        created: new Date().toISOString(),
        branded: !gate.isPro(),
    };
    const all = getInvoices();
    all.push(inv);
    setInvoices(all);
    return inv;
}
/* ------------------------------------------------------------------- server */
const server = new McpServer({ name: "mcp-quotes", version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
server.registerTool("quote_create", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Create a quote",
    description: "Store a quote for client from items and return its Q number, VAT and totals. unit_price is in MAJOR units; currency, VAT and issuer come from the shared profile. A duplicate of an open quote is refused. Free: 5 open.",
    inputSchema: {
        client: z.string().min(1, "client is required").max(MAX_CLIENT_NAME, `client must be ${MAX_CLIENT_NAME} characters or fewer`)
            .describe("Client name or id. A name the invoice server already knows brings its address, email and VAT id onto the quote"),
        items: z.array(itemSchema).min(1, "a quote needs at least one line item").max(MAX_ITEMS, `a quote can carry at most ${MAX_ITEMS} line items`).describe("The line items being quoted"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional().describe("Defaults to your business default currency"),
        validity_days: z.number().int().min(1).max(MAX_VALIDITY_DAYS).optional().describe(`Days the quote stays valid, counted from the quote date and inclusive. Default ${DEFAULT_VALIDITY_DAYS}`),
        valid_until: z.string().optional().describe("YYYY-MM-DD, an explicit last valid day. Wins over validity_days"),
        issue_date: z.string().optional().describe("YYYY-MM-DD, defaults to today in your business profile's timezone"),
        discount_percent: z.number().finite().min(0).max(100).optional().describe("Discount applied to every line, in percent"),
        tax_rate: z.number().finite().min(0).max(1000).optional().describe("VAT percent for lines with no rate of their own. Defaults to the business default"),
        notes: text("notes", MAX_NOTES).optional().describe(`Free text printed under the totals, e.g. scope or exclusions. ${MAX_NOTES} characters or fewer`),
        client_email: text("client_email", MAX_EMAIL).optional().describe("Only if the user gave it; otherwise the stored client's email is used"),
        client_address: text("client_address", MAX_ADDRESS).optional().describe("Postal address for the QUOTE FOR block, newlines allowed"),
        client_vat_id: text("client_vat_id", MAX_VAT_ID).optional().describe("Client VAT / tax registration id"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const day = today();
            const issue = a.issue_date ?? day;
            if (!isIsoDate(issue))
                return fail(`issue_date "${a.issue_date}" is not a real date in YYYY-MM-DD form.`);
            if (a.valid_until !== undefined && !isIsoDate(a.valid_until)) {
                return fail(`valid_until "${a.valid_until}" is not a real date in YYYY-MM-DD form.`);
            }
            const validUntil = a.valid_until ?? addDays(issue, a.validity_days ?? DEFAULT_VALIDITY_DAYS);
            if (validUntil < issue)
                return fail(`valid_until ${validUntil} is before the quote date ${issue}. Nothing was stored.`);
            const list = getQuotes();
            const biz = issuer();
            const currency = resolveCurrency(a.items, a.currency, biz.default_currency);
            const totals = totalsFor(a.items, currency, a.discount_percent ?? 0, a.tax_rate ?? biz.default_tax_rate);
            const stored = findClient(a.client);
            const clientName = stored?.name ?? a.client.trim();
            // Before the cap and before an id is allocated: the duplicate is what a free slot
            // gets spent on, so the guard has to fire while there is still room to spend. Closed
            // quotes are left out on purpose -- re-quoting the same work after an accept or a
            // decline is a new offer, not a second copy of an open one.
            const mine = quoteFingerprint({
                client: { name: clientName }, currency, issue_date: issue, valid_until: validUntil,
                discount_percent: totals.discount_percent, lines: totals.lines,
                total_minor: totals.total_minor, notes: a.notes,
            });
            const twin = list.find((x) => x.status === "open" && quoteFingerprint(x) === mine);
            if (twin) {
                return fail(`this is quote ${twin.id} again, line for line: same client (${twin.client.name}), same ` +
                    `${twin.lines.length} line item(s), same total ${formatMoney(twin.total_minor, twin.currency)}, ` +
                    `same quote date ${twin.issue_date}, same validity to ${twin.valid_until} and the same notes. ` +
                    `${twin.id} is ${stateOf(twin, day)}. Nothing was written and no free open slot was used. ` +
                    `Send it again with quote_send_text {id: "${twin.id}"}, or revise it with quote_update {id: "${twin.id}"}. ` +
                    `If ${twin.id} was created in error, remove it with quote_delete {id: "${twin.id}"} and its slot comes back.`);
            }
            if (!gate.isPro() && openCount(list, day) >= FREE_OPEN_QUOTES) {
                return fail(`the free tier keeps ${FREE_OPEN_QUOTES} quotes open at a time and you have ${openCount(list, day)}. ` +
                    `Accept or decline one, or upgrade. ${gate.upgradeText("unlimited open quotes", "quote_create")}`);
            }
            const q = {
                id: nextQuoteId(issue.slice(0, 4), list),
                client_id: stored?.id,
                client: {
                    name: clientName,
                    address: a.client_address ?? stored?.address,
                    email: a.client_email ?? stored?.email,
                    vat_id: a.client_vat_id ?? stored?.vat_id,
                },
                issue_date: issue,
                valid_until: validUntil,
                validity_days: daysBetween(issue, validUntil),
                currency,
                decimals: totals.decimals,
                lines: totals.lines,
                subtotal_minor: totals.subtotal_minor,
                discount_percent: totals.discount_percent,
                discount_minor: totals.discount_minor,
                net_minor: totals.net_minor,
                tax_lines: totals.tax_lines,
                tax_minor: totals.tax_minor,
                total_minor: totals.total_minor,
                notes: a.notes,
                status: "open",
                created: new Date().toISOString(),
                updated: new Date().toISOString(),
                branded: !gate.isPro(),
            };
            list.push(q);
            setQuotes(list);
            const notes = [];
            if (businessMissing())
                notes.push(NO_BUSINESS_NOTE);
            if (!stored) {
                notes.push(`"${q.client.name}" is not a stored client, so the QUOTE FOR block has ${q.client.address ? "the address you gave" : "no address"}. ` +
                    `client_add in the invoice server stores it once for every later document.`);
            }
            if (!gate.isPro()) {
                notes.push(`Free tier: ${openCount(getQuotes(), day)} of ${FREE_OPEN_QUOTES} open quotes used. ` +
                    `Accepting, declining or quote_delete on an unsent draft gives the slot back, all free. quote_pdf and quote_report are Pro.`);
            }
            return json({ created: detail(q, day), notes: notes.length ? notes : undefined });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_list", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "List quotes",
    description: "List quotes newest first: id, client, dates, state, days left while open, currency, total and the invoice number once accepted. State is read against today, so a lapsed quote shows as expired.",
    inputSchema: {
        state: z.enum(["open", "expired", "accepted", "declined", "all"]).optional().describe('Default "all". "open" excludes quotes whose validity has run out; "expired" is only those'),
        client: z.string().optional().describe("Only quotes for clients whose name contains this text"),
        from: z.string().optional().describe("YYYY-MM-DD, earliest quote date"),
        to: z.string().optional().describe("YYYY-MM-DD, latest quote date"),
    },
}, async (a) => {
    try {
        const day = today();
        let list = getQuotes();
        if (a.state && a.state !== "all")
            list = list.filter((q) => stateOf(q, day) === a.state);
        if (a.client) {
            const needle = a.client.trim().toLowerCase();
            list = list.filter((q) => q.client.name.toLowerCase().includes(needle));
        }
        if (a.from)
            list = list.filter((q) => q.issue_date >= a.from);
        if (a.to)
            list = list.filter((q) => q.issue_date <= a.to);
        list = [...list].sort((x, y) => y.issue_date.localeCompare(x.issue_date) || y.id.localeCompare(x.id));
        return json({ count: list.length, quotes: list.map((q) => summarize(q, day)) });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_get", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "Show one quote",
    description: "Return one quote in full by Q number or exact client name: lines with unit price and VAT, totals, dates, the state today with days left, notes, and the invoice it became once accepted. Reads only.",
    inputSchema: { id: z.string().describe("Quote id such as Q-2026-0001, or an exact client name") },
}, async (a) => {
    try {
        const day = today();
        const q = findQuote(getQuotes(), a.id);
        if (!q)
            return fail(`no quote matches "${a.id}". Run quote_list to see the ids.`);
        return json(detail(q, day));
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_update", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Change an open quote",
    description: "Revise a quote that is still open: line items, currency, discount, VAT default, validity or notes. Totals are recomputed. An accepted or declined quote is never edited.",
    inputSchema: {
        id: z.string().describe("Quote id such as Q-2026-0001"),
        items: z.array(itemSchema).min(1).max(MAX_ITEMS).optional().describe("Replaces every line item"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional(),
        discount_percent: z.number().finite().min(0).max(100).optional(),
        tax_rate: z.number().finite().min(0).max(1000).optional().describe("VAT percent for lines with no rate of their own"),
        validity_days: z.number().int().min(1).max(MAX_VALIDITY_DAYS).optional().describe("Recomputes valid_until from the quote date"),
        valid_until: z.string().optional().describe("YYYY-MM-DD. Wins over validity_days, and is how an expired quote is extended"),
        notes: text("notes", MAX_NOTES).optional(),
        client_email: text("client_email", MAX_EMAIL).optional(),
        client_address: text("client_address", MAX_ADDRESS).optional(),
        client_vat_id: text("client_vat_id", MAX_VAT_ID).optional(),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const day = today();
            const list = getQuotes();
            const q = findQuote(list, a.id);
            if (!q)
                return fail(`no quote matches "${a.id}". Run quote_list to see the ids.`);
            if (q.status !== "open") {
                return fail(`${q.id} was ${q.status}${q.invoice_number ? ` and invoiced as ${q.invoice_number}` : ""} on ` +
                    `${q.accepted_date ?? q.declined_date}, so it is a closed document and is not edited. ` +
                    `Create a new quote instead; the old one stays as the record of what the client saw.`);
            }
            if (a.valid_until !== undefined && !isIsoDate(a.valid_until)) {
                return fail(`valid_until "${a.valid_until}" is not a real date in YYYY-MM-DD form.`);
            }
            const biz = issuer();
            if (a.items || a.currency || a.discount_percent !== undefined || a.tax_rate !== undefined) {
                const items = a.items ?? q.lines.map((l) => ({
                    description: l.description, quantity: l.quantity,
                    unit_price_minor: l.unit_price_minor, tax_rate: l.tax_rate,
                }));
                const currency = resolveCurrency(items, a.currency ?? q.currency, q.currency);
                const discount = a.discount_percent ?? q.discount_percent;
                const totals = totalsFor(items, currency, discount, a.tax_rate ?? biz.default_tax_rate);
                q.currency = currency;
                q.decimals = totals.decimals;
                q.lines = totals.lines;
                q.subtotal_minor = totals.subtotal_minor;
                q.discount_percent = totals.discount_percent;
                q.discount_minor = totals.discount_minor;
                q.net_minor = totals.net_minor;
                q.tax_lines = totals.tax_lines;
                q.tax_minor = totals.tax_minor;
                q.total_minor = totals.total_minor;
            }
            if (a.valid_until !== undefined)
                q.valid_until = a.valid_until;
            else if (a.validity_days !== undefined)
                q.valid_until = addDays(q.issue_date, a.validity_days);
            if (q.valid_until < q.issue_date)
                return fail(`valid_until ${q.valid_until} is before the quote date ${q.issue_date}. Nothing was changed.`);
            q.validity_days = daysBetween(q.issue_date, q.valid_until);
            if (a.notes !== undefined)
                q.notes = a.notes;
            if (a.client_email !== undefined)
                q.client.email = a.client_email;
            if (a.client_address !== undefined)
                q.client.address = a.client_address;
            if (a.client_vat_id !== undefined)
                q.client.vat_id = a.client_vat_id;
            q.updated = new Date().toISOString();
            setQuotes(list);
            return json({ updated: detail(q, day) });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_send_text", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Plain-text quote to paste into email",
    description: "Turn a quote into a plain-text summary to paste into an email: the line table, VAT lines, total and validity date, with a sign-off from the shared profile. Free; quote_pdf writes the A4 document.",
    inputSchema: {
        id: z.string().describe("Quote id such as Q-2026-0001"),
        greeting: z.string().optional().describe("Opening line, default \"Hello\" plus the client name"),
        sign_off: z.string().optional().describe("Closing line, default your business name from the shared profile"),
    },
}, async (a) => {
    try {
        const day = today();
        const q = findQuote(getQuotes(), a.id);
        if (!q)
            return fail(`no quote matches "${a.id}". Run quote_list to see the ids.`);
        const biz = issuer();
        const pad = (s, n) => s.length >= n ? s : s + " ".repeat(n - s.length);
        const padL = (s, n) => s.length >= n ? s : " ".repeat(n - s.length) + s;
        const descW = Math.min(40, Math.max(12, ...q.lines.map((l) => l.description.length)));
        const rows = q.lines.map((l) => `  ${pad(l.description.slice(0, descW), descW)}  ${padL(String(l.quantity), 6)} x ${padL(formatMoney(l.unit_price_minor, q.currency), 14)}  ${padL(formatMoney(l.gross_minor, q.currency), 14)}`);
        // The totals block right-aligns its label so its amount column lands under the line
        // amounts: 2 + descW + 2 + 6 + 3 + 14 + 2 characters of prefix, whatever descW is.
        const labels = ["Subtotal", "TOTAL", `Discount ${q.discount_percent}%`, "Net",
            ...q.tax_lines.map((t) => `VAT ${t.rate}% on ${formatMoney(t.base_minor, q.currency)}`)];
        const labelW = Math.max(descW + 25, ...labels.map((s) => s.length));
        const totalRow = (label, value) => `  ${padL(label, labelW)}  ${padL(value, 14)}`;
        const out = [];
        out.push(a.greeting ?? `Hello ${q.client.name},`);
        out.push("");
        out.push(`Here is quote ${q.id}, dated ${q.issue_date}.`);
        out.push("");
        out.push(...rows);
        out.push("");
        out.push(totalRow("Subtotal", formatMoney(q.subtotal_minor, q.currency)));
        if (q.discount_minor) {
            out.push(totalRow(`Discount ${q.discount_percent}%`, "-" + formatMoney(q.discount_minor, q.currency)));
            out.push(totalRow("Net", formatMoney(q.net_minor, q.currency)));
        }
        for (const t of q.tax_lines) {
            if (!t.rate && !t.tax_minor)
                continue;
            out.push(totalRow(`VAT ${t.rate}% on ${formatMoney(t.base_minor, q.currency)}`, formatMoney(t.tax_minor, q.currency)));
        }
        out.push(totalRow("TOTAL", formatMoney(q.total_minor, q.currency)));
        out.push("");
        if (q.notes) {
            out.push(q.notes);
            out.push("");
        }
        out.push(stateOf(q, day) === "expired"
            ? `This quote was valid until ${q.valid_until} and has lapsed. Tell me if you would like it re-issued.`
            : `This quote is valid until ${q.valid_until}. Reply to accept and I will invoice as quoted.`);
        out.push("");
        out.push(a.sign_off ?? (biz.name === PLACEHOLDER_ISSUER ? "Best regards," : `Best regards,\n${biz.name}`));
        const text = out.join("\n");
        const body = businessMissing() ? `${text}\n\n---\n${NO_BUSINESS_NOTE}` : text;
        // Handing the text over is what turns a draft into a document the client holds, so it
        // is stamped on the record. quote_delete reads the stamp: an offer that is already out
        // is not deleted quietly. Only the first send is stamped; the date is when they saw it.
        await locked(() => {
            const list = getQuotes();
            const rec = list.find((x) => x.id === q.id);
            if (rec && !rec.sent_date) {
                rec.sent_date = day;
                rec.updated = new Date().toISOString();
                setQuotes(list);
            }
        });
        return ok(body);
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_accept", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Accept a quote",
    description: "Mark a quote accepted and turn it into an invoice: created directly in the invoice server when its store is present, otherwise returned as invoice_create-ready line items. The numbers are copied, never recomputed.",
    inputSchema: {
        id: z.string().describe("Quote id such as Q-2026-0001"),
        create_invoice: z.enum(["auto", "always", "never"]).optional().describe('Default "auto": create the invoice when the invoice store exists, otherwise hand back the items. "never" only marks it accepted'),
        issue_date: z.string().optional().describe("YYYY-MM-DD for the invoice, defaults to today"),
        due_days: z.number().int().min(0).max(3650).optional().describe("Days until the invoice is due, defaults to your payment terms"),
        allow_expired: z.boolean().optional().describe("Accept a quote whose validity has run out. Default false: an expired quote is refused so the price is re-confirmed first"),
    },
}, async (a) => {
    try {
        return await lockedWithInvoice(() => {
            const day = today();
            const list = getQuotes();
            const q = findQuote(list, a.id);
            if (!q)
                return fail(`no quote matches "${a.id}". Run quote_list to see the ids.`);
            if (q.status === "accepted") {
                return fail(`${q.id} was already accepted on ${q.accepted_date}` +
                    `${q.invoice_number ? ` and invoiced as ${q.invoice_number}` : " (no invoice was created)"}. ` +
                    `Accepting it again would issue a second invoice for the same work, so nothing was done.`);
            }
            if (q.status === "declined") {
                return fail(`${q.id} was declined on ${q.declined_date}${q.decline_reason ? ` (${q.decline_reason})` : ""}. Create a new quote instead of reviving it.`);
            }
            if (isExpired(q, day) && a.allow_expired !== true) {
                return fail(`${q.id} was valid until ${q.valid_until} and today is ${day}, so it has lapsed by ` +
                    `${daysBetween(q.valid_until, day)} day(s). Re-confirm the price with the client, then either ` +
                    `quote_update {id, valid_until} to extend it or quote_accept {id, allow_expired: true}. Nothing was changed.`);
            }
            const issue = a.issue_date ?? day;
            if (!isIsoDate(issue))
                return fail(`issue_date "${a.issue_date}" is not a real date in YYYY-MM-DD form.`);
            const mode = a.create_invoice ?? "auto";
            const present = invoiceStorePresent();
            const makeInvoice = mode === "always" || (mode === "auto" && present);
            let inv;
            if (makeInvoice)
                inv = issueInvoiceFromQuote(q, a.due_days, issue);
            q.status = "accepted";
            q.accepted_date = day;
            q.invoice_number = inv?.number;
            q.updated = new Date().toISOString();
            setQuotes(list);
            const notes = [];
            if (inv) {
                notes.push(`Invoice ${inv.number} was created in the invoice server's own store (${dataDir().replace(/quotes$/, "invoice")}), ` +
                    `under its number series. Render it there with invoice_pdf {number: "${inv.number}"}.`);
                notes.push("Written through the shared invoice engine, so the invoice server's own free cap of 3 invoices per month does not apply to it; the quotes free cap applies to quotes.");
            }
            else {
                notes.push(mode === "never"
                    ? "Marked accepted only. The items below are ready for invoice_create in the invoice server."
                    : "The invoice server has no store on this machine yet, so nothing was invoiced. Pass the items below to invoice_create, or call quote_accept {create_invoice: \"always\"}.");
            }
            if (businessMissing())
                notes.push(NO_BUSINESS_NOTE);
            return json({
                accepted: summarize(q, day),
                invoice_number: inv?.number,
                invoice_due_date: inv?.due_date,
                invoice_create_args: inv ? undefined : {
                    client: q.client.name, currency: q.currency,
                    discount_percent: q.discount_percent || undefined,
                    notes: q.notes, items: invoiceItems(q),
                },
                totals_check: {
                    quote_total: formatMoney(q.total_minor, q.currency),
                    invoice_total: inv ? formatMoney(inv.total_minor, inv.currency) : undefined,
                },
                notes,
            });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_decline", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Decline a quote",
    description: "Mark a quote lost, with a reason kept on the record, freeing a free-tier open slot and counting in the win rate. An accepted quote is refused, naming the invoice it became. Free on every tier.",
    inputSchema: {
        id: z.string().describe("Quote id such as Q-2026-0001"),
        reason: text("reason", MAX_NOTES).optional().describe("Why it was lost, e.g. \"price\" or \"went in-house\". Kept on the record"),
        date: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const day = today();
            const list = getQuotes();
            const q = findQuote(list, a.id);
            if (!q)
                return fail(`no quote matches "${a.id}". Run quote_list to see the ids.`);
            if (q.status === "accepted") {
                return fail(`${q.id} was accepted on ${q.accepted_date}${q.invoice_number ? ` and invoiced as ${q.invoice_number}` : ""}. ` +
                    `Declining it would leave that invoice with no quote behind it; cancel the invoice in the invoice server instead.`);
            }
            if (q.status === "declined")
                return fail(`${q.id} was already declined on ${q.declined_date}. Nothing was changed.`);
            const when = a.date ?? day;
            if (!isIsoDate(when))
                return fail(`date "${a.date}" is not a real date in YYYY-MM-DD form.`);
            q.status = "declined";
            q.declined_date = when;
            q.decline_reason = a.reason;
            q.updated = new Date().toISOString();
            setQuotes(list);
            return json({ declined: summarize(q, day), reason: q.decline_reason, open_quotes_now: openCount(list, day) });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
/**
 * D-R19 (amortization) applies here: a create tool with no delete tool turns one duplicated
 * record into a free slot the user cannot get back except with a Pro key. The duplicate
 * guard in quote_create is one half of the answer; this is the other. It removes a DRAFT
 * only -- a quote nobody outside this machine has seen -- so nothing that is a record of
 * what a client was told can be deleted, and it genuinely frees the slot, because the cap
 * counts quotes in the open state and the row is gone from the store.
 */
server.registerTool("quote_delete", { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    title: "Delete a draft quote",
    description: "Delete a draft quote that was never sent, accepted, invoiced or exported, and give its free open-quote slot back. A quote with any of those is refused with the dependent named. The id is never reissued.",
    inputSchema: {
        id: z.string().describe("Quote id such as Q-2026-0001"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const day = today();
            const list = getQuotes();
            const q = findQuote(list, a.id);
            if (!q)
                return fail(`no quote matches "${a.id}". Run quote_list to see the ids.`);
            const deps = dependentsOf(q);
            if (deps.length) {
                return fail(`${q.id} (${q.client.name}, ${formatMoney(q.total_minor, q.currency)}) is not a draft: ` +
                    `${deps.join("; ")}. Deleting it would leave that behind with no quote to point at, so nothing was deleted. ` +
                    `${q.status === "open" ? `quote_decline {id: "${q.id}"} closes it instead, and that frees the open slot just as well.` : `It is already ${q.status}, so it costs no open slot.`}`);
            }
            const before = openCount(list, day);
            const rest = list.filter((x) => x.id !== q.id);
            setQuotes(rest);
            const after = openCount(rest, day);
            const notes = [
                `${q.id} is gone from the store and is never reissued: the year counter keeps moving, so the next quote gets a new id.`,
                "The record is echoed back in full, so an accidental delete can be re-created with quote_create.",
            ];
            if (!gate.isPro()) {
                notes.push(`Free tier: ${after} of ${FREE_OPEN_QUOTES} open quotes used${before > after ? ", one slot freed" : ""}.`);
            }
            return json({ deleted: detail(q, day), open_quotes_now: after, slot_freed: before > after, notes });
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_pdf", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "Render the quote as a PDF",
    description: "Call this tool to write one quote as an A4 PDF and return the path: the invoice layout with the validity date, an acceptance block, and an EXPIRED marking once it has lapsed. Pro.",
    inputSchema: {
        id: z.string().describe("Quote id such as Q-2026-0001"),
        out_path: z.string().optional().describe("Where to write the file. Defaults to the quotes data directory under pdf/"),
    },
}, async (a) => {
    try {
        if (!gate.isPro())
            return fail(gate.upgradeText("quote PDF", "quote_pdf"));
        const day = today();
        const q = findQuote(getQuotes(), a.id);
        if (!q)
            return fail(`no quote matches "${a.id}". Run quote_list to see the ids.`);
        const out = a.out_path ? expandPath(a.out_path) : join(dataDir(), "pdf", `${q.id}.pdf`);
        const biz = issuer();
        await renderQuotePdf(q, biz, out, { branded: !gate.isPro(), logo: gate.isPro(), expired: isExpired(q, day) });
        // The rendered file outlives this call and is what someone sends or files, so where it
        // went is stored: quote_delete counts it as a dependent while it is still on disk.
        await locked(() => {
            const list = getQuotes();
            const rec = list.find((x) => x.id === q.id);
            if (rec) {
                rec.exported_path = out;
                rec.updated = new Date().toISOString();
                setQuotes(list);
            }
        });
        const notes = [];
        if (businessMissing())
            notes.push(NO_BUSINESS_NOTE);
        if (isExpired(q, day))
            notes.push(`This quote lapsed on ${q.valid_until}; the PDF says EXPIRED. quote_update {id, valid_until} re-dates it.`);
        return json({ quote: q.id, path: out, document: /\.html?$/i.test(out) ? "HTML quote (print to PDF)" : "PDF quote", total: formatMoney(q.total_minor, q.currency), notes: notes.length ? notes : undefined });
    }
    catch (e) {
        return fail(e.message);
    }
});
server.registerTool("quote_report", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "Quote pipeline and win rate",
    description: "Totals per currency for open, accepted, declined and expired quotes, with counts, the value still open and the win rate. Free covers the current calendar year to date; Pro reports over any date range.",
    inputSchema: {
        from: z.string().optional().describe("YYYY-MM-DD, earliest quote date to count"),
        to: z.string().optional().describe("YYYY-MM-DD, latest quote date to count"),
    },
}, async (a) => {
    try {
        const pro = gate.isPro();
        const day = today();
        // The free tier answers over the current calendar year to date rather than refusing:
        // a report withheld is recomputed by hand, and the win-rate basis is the part that
        // gets it wrong.
        const yearStart = `${day.slice(0, 4)}-01-01`;
        let from = a.from;
        let capNote;
        if (!pro && (!from || from < yearStart)) {
            from = yearStart;
            capNote = `Free tier reports the current calendar year to date (${yearStart} onwards)${a.from ? ` instead of ${a.from}` : ""}; ` +
                gate.upgradeText("the pipeline report over any date range", "quote_report");
        }
        let list = getQuotes();
        if (from)
            list = list.filter((q) => q.issue_date >= from);
        if (a.to)
            list = list.filter((q) => q.issue_date <= a.to);
        const states = ["open", "accepted", "declined", "expired"];
        const byCurrency = new Map();
        for (const q of list) {
            const cur = byCurrency.get(q.currency) ?? Object.fromEntries(states.map((s) => [s, { count: 0, total_minor: 0 }]));
            const bucket = cur[stateOf(q, day)];
            bucket.count += 1;
            bucket.total_minor += q.total_minor;
            byCurrency.set(q.currency, cur);
        }
        const counts = Object.fromEntries(states.map((s) => [s, list.filter((q) => stateOf(q, day) === s).length]));
        const decided = counts.accepted + counts.declined;
        const closed = decided + counts.expired;
        const pct = (n, d) => d === 0 ? null : Math.round((n / d) * 1000) / 10;
        return json({
            as_of: day,
            from, to: a.to,
            free_tier_note: capNote,
            quotes: list.length,
            counts,
            by_currency: [...byCurrency.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([currency, b]) => ({
                currency,
                ...Object.fromEntries(states.map((s) => [s, { count: b[s].count, total: formatMoney(b[s].total_minor, currency), total_minor: b[s].total_minor }])),
            })),
            win_rate_percent: pct(counts.accepted, decided),
            win_rate_basis: "accepted / (accepted + declined). A quote nobody answered is not a loss the client chose",
            win_rate_including_expired_percent: pct(counts.accepted, closed),
            note: counts.expired
                ? `${counts.expired} quote(s) lapsed without an answer. They are counted in the second win rate only.`
                : undefined,
        });
    }
    catch (e) {
        return fail(e.message);
    }
});
gate.registerTools(server);
/* ------------------------------------------------------ resource and prompt */
server.registerResource("open-quotes", "quotes://open", {
    title: "Open quotes",
    description: "Every quote that is still open and inside its validity window, as JSON.",
    mimeType: "application/json",
}, async () => {
    const day = today();
    const open = getQuotes().filter((q) => stateOf(q, day) === "open").map((q) => summarize(q, day));
    return { contents: [{ uri: "quotes://open", mimeType: "application/json", text: JSON.stringify(open, null, 2) }] };
});
server.registerPrompt("quote_followup", {
    title: "Chase the open quotes",
    description: "Review which quotes are still open, which lapse soon and which have already lapsed, then draft the follow-up.",
    argsSchema: {},
}, () => ({
    messages: [{
            role: "user",
            content: {
                type: "text",
                text: [
                    "1. Call quote_list with state \"open\" and list them by how few days are left.",
                    "2. Call quote_list with state \"expired\" and name every quote that lapsed with no answer.",
                    "3. For the one closest to lapsing, call quote_send_text and draft a short follow-up email around it.",
                    "4. Tell me which of them to chase today and what to say, in one line each.",
                ].join("\n"),
            },
        }],
}));
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write("mcp-quotes ready\n");
