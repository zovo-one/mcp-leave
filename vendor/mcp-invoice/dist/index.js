#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, inferTimezoneFromAddress, readSharedProfile, withFileLock, writeSharedProfile, } from "@theluckystrike/mcp-license";
import { z } from "zod";
import { addDays, computeTotals, daysBetween, formatMoney, isoDate, toMinor, } from "./money.js";
import { renderInvoicePdf } from "./pdf.js";
import { creditedMinorFor, dataDir, findClient, getBusiness, getClients, getInvoices, hasBusiness, invoicesInMonth, nextNumber, setBusiness, setClients, setInvoices, } from "./store.js";
import { VERSION } from "./version.js";
const FREE_INVOICES_PER_MONTH = 3;
const BUSINESS_FIELDS = [
    "name", "address", "email", "phone", "timezone", "vat_id", "iban", "bank", "logo_path",
    "default_currency", "default_tax_rate", "payment_terms_days", "invoice_prefix",
    "tax_rate", "vat_rate", "vat",
];
const gate = createLicenseGate({ product: "invoice" });
/**
 * D-R60. Every server that imports readSharedProfile, other than invoice itself, in the
 * order `grep -rl readSharedProfile servers/*\/src` returns them. test/profile-readers.test.mjs
 * re-runs that grep and fails if this list ever drifts from it, so a server that starts (or
 * stops) reading the shared profile cannot go unnoticed here again.
 */
export const PROFILE_READERS = [
    "asset-register", "bank-statement", "barcode", "bill-of-sale", "calendar", "catalogue", "change-order", "checklist", "clauses", "currency", "delivery-schedule", "docx", "dunning-letters", "expense-tracker",
    "image", "kanban", "leave", "packing-list", "pdf", "per-diem", "petty-cash", "quotes", "resume", "statement-of-account", "time-tracker", "timezone",
    "purchase-requisition",
    "purchaseRequisition",
    "work-order",
];
/**
 * Serialise every read-modify-write cycle on the data dir across processes.
 * Two instances sharing one XDG_DATA_HOME otherwise overwrite each other's
 * clients.json / invoices.json / counter.json (see docs/AUDIT.md).
 */
function locked(fn) {
    return withFileLock(join(dataDir(), ".lock"), fn);
}
const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const json = (v) => ok(JSON.stringify(v, null, 2));
/**
 * D-R2: a missing business profile must never block the invoice. The document is
 * created with a placeholder issuer and the response says so in one line.
 */
const PLACEHOLDER_ISSUER = "Your business";
const NO_BUSINESS_NOTE = "No business profile yet: the PDF shows a placeholder issuer. " +
    "Run business_set {name, address, vat_id, iban} and render the PDF again.";
function businessMissing() {
    return !hasBusiness() || !getBusiness().name.trim();
}
/** The issuer block used on every document: the stored profile, or the placeholder. */
function issuer() {
    const b = getBusiness();
    return b.name.trim() ? b : { ...b, name: PLACEHOLDER_ISSUER };
}
/**
 * D-R6: only call a file a PDF when it is one. The stdio server always writes PDF
 * bytes; an .html path (or an HTML link handed over by another transport) is
 * described as a printable HTML invoice instead.
 */
function documentLabel(pathOrLink, html) {
    return (html ?? /\.html?(\?|#|$)/i.test(pathOrLink)) ? "HTML invoice (print to PDF)" : "PDF invoice";
}
/**
 * D-R96: total_minor - paid_minor alone ignores a credit note issued against this
 * invoice in the billing-docs store; statement-of-account already nets them (see
 * ageClient in servers/statement-of-account/src/statement.ts), this floors the same
 * way it does - a credit note larger than what is still open cannot make the balance
 * negative, it just clears it.
 */
function netBalance(inv) {
    const credited_minor = creditedMinorFor(inv.number, inv.currency);
    const open_minor = Math.max(0, inv.total_minor - inv.paid_minor - credited_minor);
    return { credited_minor, open_minor };
}
function summarize(inv) {
    const { credited_minor, open_minor } = netBalance(inv);
    return {
        number: inv.number,
        client: inv.client.name,
        issue_date: inv.issue_date,
        due_date: inv.due_date,
        currency: inv.currency,
        subtotal: formatMoney(inv.subtotal_minor, inv.currency),
        discount: inv.discount_minor ? formatMoney(inv.discount_minor, inv.currency) : undefined,
        tax: inv.tax_lines.filter((t) => t.rate || t.tax_minor)
            .map((t) => `${t.rate}% on ${formatMoney(t.base_minor, inv.currency)} = ${formatMoney(t.tax_minor, inv.currency)}`),
        total: formatMoney(inv.total_minor, inv.currency),
        total_minor: inv.total_minor,
        status: inv.status,
        paid: inv.paid_minor ? formatMoney(inv.paid_minor, inv.currency) : undefined,
        credited: credited_minor ? formatMoney(credited_minor, inv.currency) : undefined,
        balance_due: formatMoney(open_minor, inv.currency),
    };
}
/**
 * Line detail for the text response. Every money value carries its currency
 * code (D-8, user-value audit 2026-09-02) so no amount on an invoice is ever
 * printed as a bare number.
 */
function lineRows(inv) {
    return inv.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unit_price: formatMoney(l.unit_price_minor, inv.currency),
        tax_rate: `${l.tax_rate}%`,
        amount: formatMoney(l.gross_minor, inv.currency),
    }));
}
/**
 * D-R46: when a unit price is rounded to a whole cent before being multiplied by the
 * quantity (the default, D-R24, basis), the printed line can sit a cent or two above or
 * below the amount an fx conversion actually names. Say so, and name the fix.
 */
function roundingNote(inv) {
    const drift = inv.rounding_drift_minor ?? 0;
    if (!drift)
        return undefined;
    const above = drift > 0;
    const amount = formatMoney(Math.abs(drift), inv.currency);
    return (`rounding_note: this invoice's total is ${amount} ${above ? "above" : "below"} the exact ` +
        `converted amount, because at least one unit price is rounded to the nearest cent before ` +
        `being multiplied by the quantity (the D-R24 basis: unit_price_minor x quantity always ` +
        `equals the printed line, so the invoice adds up on a calculator). Pass round_total: true ` +
        `on that item (or the whole call, for invoice_from_hours) to round the line's TOTAL to the ` +
        `exact converted amount instead - the trade-off is that unit_price x quantity may then be a ` +
        `cent or two off the printed total, for the same reason in reverse.`);
}
function expandPath(p) {
    const s = p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
    return isAbsolute(s) ? s : resolvePath(process.cwd(), s);
}
const server = new McpServer({ name: "mcp-invoice", version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
/* ------------------------------------------------------------------ business */
server.registerTool("business_set", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Set your business details",
    description: "The ONE business profile for the whole suite: name, address, VAT id, bank details and defaults (currency, tax rate, terms, prefix, timezone). Saved to the shared profile every other server reads. Call it once, first.",
    inputSchema: z.object({
        name: z.string().describe("Your business or freelancer name"),
        address: z.string().optional().describe("Postal address, newlines allowed"),
        email: z.string().optional().describe("Your own email address. Leave it out unless the user gave it: no server ever fills an email from anything but this profile or an explicit argument"),
        phone: z.string().optional().describe("Your own phone number. Same rule as email: only if the user gave it"),
        timezone: z.string().optional().describe("IANA zone you work in, e.g. Europe/Warsaw. Shared with time-tracker (entries are stamped in it) and timezone (your home zone)"),
        vat_id: z.string().optional().describe("VAT / tax registration id"),
        iban: z.string().optional().describe("IBAN or account number for payment"),
        bank: z.string().optional().describe("Bank name / BIC"),
        logo_path: z.string().optional().describe("Path to a PNG or JPG logo (Pro)"),
        default_currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional().describe("ISO code, e.g. EUR, USD, JPY. Default EUR"),
        default_tax_rate: z.number().optional().describe("Default VAT percent applied to items without their own rate"),
        payment_terms_days: z.number().optional().describe("Default days until due. Default 14"),
        invoice_prefix: z.string().optional().describe("Invoice number prefix, default INV (custom prefix is Pro)"),
        tax_rate: z.number().optional().describe("Alias for default_tax_rate"),
        vat_rate: z.number().optional().describe("Alias for default_tax_rate"),
        vat: z.number().optional().describe("Alias for default_tax_rate"),
    }).passthrough(),
}, async (a) => {
    try {
        return await locked(() => {
            const prev = getBusiness();
            // D-R7: "tax rate" is what users and models say; default_tax_rate is what the
            // field is called. Accept the aliases, and never drop a key in silence.
            const aliasKey = ["tax_rate", "vat_rate", "vat"].find((k) => typeof a[k] === "number");
            const taxRate = a.default_tax_rate ?? (aliasKey ? a[aliasKey] : undefined);
            const unknown = Object.keys(a).filter((k) => !BUSINESS_FIELDS.includes(k));
            let warn = "";
            if (aliasKey)
                warn += `\n\nRead ${aliasKey}: ${a[aliasKey]} as default_tax_rate: ${taxRate}.`;
            if (unknown.length) {
                warn += `\n\nWarning: ignored unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}. ` +
                    `Accepted fields: ${BUSINESS_FIELDS.join(", ")}.`;
            }
            let prefix = a.invoice_prefix ?? prev.invoice_prefix;
            let note = "";
            if (a.invoice_prefix && a.invoice_prefix !== "INV" && !gate.isPro()) {
                prefix = "INV";
                note = `\n\nNote: custom invoice prefix is a Pro feature, kept "INV". ${gate.upgradeText("custom invoice prefix", "business_set")}`;
            }
            const biz = {
                name: a.name,
                address: a.address ?? prev.address,
                email: a.email ?? prev.email,
                vat_id: a.vat_id ?? prev.vat_id,
                iban: a.iban ?? prev.iban,
                bank: a.bank ?? prev.bank,
                logo_path: a.logo_path ?? prev.logo_path,
                default_currency: (a.default_currency ?? prev.default_currency).toUpperCase(),
                default_tax_rate: taxRate ?? prev.default_tax_rate,
                payment_terms_days: a.payment_terms_days ?? prev.payment_terms_days,
                invoice_prefix: prefix.replace(/[^A-Za-z0-9_-]/g, "") || "INV",
            };
            setBusiness(biz);
            // D-R48: an address with no explicit timezone infers one from the last city or
            // country name in the address (the same place table the timezone server itself
            // reads for a bare place name), instead of leaving the shared profile's timezone
            // blank. An explicit timezone always wins and clears any earlier inference.
            let tzNote = "";
            const priorTimezone = readSharedProfile().timezone;
            let timezoneToWrite = a.timezone;
            let timezoneSource;
            if (a.timezone) {
                timezoneSource = null; // explicit value clears any earlier "inferred from address" marker
            }
            else if (a.address && !priorTimezone) {
                const inferred = inferTimezoneFromAddress(a.address);
                if (inferred) {
                    timezoneToWrite = inferred.zone;
                    timezoneSource = "inferred from address";
                    tzNote = `\n\nInferred timezone ${inferred.zone} from "${inferred.matched}" in the address ` +
                        `(timezone_source: "inferred from address"). Pass timezone: "Area/City" to override.`;
                }
                else {
                    tzNote = `\n\nCould not infer a timezone from the address; no city or country in it matched ` +
                        `the timezone lib's place table. Pass timezone: "Area/City" (e.g. Europe/Warsaw) if you want ` +
                        `one stored.`;
                }
            }
            if (a.phone || timezoneToWrite || timezoneSource !== undefined) {
                writeSharedProfile({ phone: a.phone, timezone: timezoneToWrite, timezone_source: timezoneSource });
            }
            const shared = readSharedProfile();
            const readerList = PROFILE_READERS.length > 1
                ? `${PROFILE_READERS.slice(0, -1).join(", ")} and ${PROFILE_READERS[PROFILE_READERS.length - 1]}`
                : PROFILE_READERS.join(", ");
            return ok(`Business profile saved to ${dataDir()}, ` +
                `which ${readerList} all read. You do not need to repeat it anywhere else.\n\n` +
                `${JSON.stringify({
                    ...biz, phone: shared.phone, timezone: shared.timezone, timezone_source: shared.timezone_source,
                }, null, 2)}${tzNote}${note}${warn}`);
        });
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
/* ------------------------------------------------------------------- clients */
/**
 * D-R97 (docs/DIST_R19_RESULT.md finding 3). A create tool that accepts the same record
 * twice, with no way to remove one, quietly burns whatever the free tier meters and the
 * only way back is a Pro key. Two halves fix that here:
 *
 *  - `client_add` compares the NORMALISED incoming record against every stored client and
 *    refuses an exact match, naming the id that already holds it. Normalisation is what a
 *    human would call the same record: trimmed, case-folded, runs of spaces collapsed,
 *    blank address lines dropped, and a tax id compared with its spacing and punctuation
 *    removed ("PL 123-456" is "pl123456"). Nothing is written on a refusal.
 *  - `client_delete` removes a client that nothing references, so the record can be undone.
 *
 * A field that differs still takes the update path below: `client_add` remains the way to
 * correct an address or a VAT id.
 */
function normText(v) {
    return String(v ?? "").replace(/\r\n/g, "\n").split("\n")
        .map((line) => line.trim().replace(/\s+/g, " ").toLowerCase())
        .filter((line) => line.length > 0).join("\n");
}
function normTaxId(v) {
    return String(v ?? "").toLowerCase().replace(/[\s.\-/]/g, "");
}
function clientFingerprint(c) {
    return [normText(c.name), normText(c.address), normText(c.email), normTaxId(c.vat_id)].join(" | ");
}
server.registerTool("client_add", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Add a client",
    description: "Store a client so invoice_create can refer to them by name. Re-adding the same name updates the stored address, email and VAT id; a record identical to a stored one is refused, naming the id that already holds it.",
    inputSchema: {
        name: z.string(),
        address: z.string().optional(),
        email: z.string().optional(),
        vat_id: z.string().optional().describe("Client VAT id, printed for reverse-charge invoices"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const clients = getClients();
            // D-R97: the duplicate check runs before anything is stored and before any cap is
            // consulted, so it fires on free and on Pro alike.
            const fingerprint = clientFingerprint({ name: a.name, address: a.address, email: a.email, vat_id: a.vat_id });
            const duplicate = clients.find((c) => clientFingerprint(c) === fingerprint);
            if (duplicate) {
                return fail(`client "${duplicate.name}" is already stored as ${duplicate.id} with exactly these details ` +
                    `(name, address, email and VAT id all match once trimmed and case-folded). Nothing was written and ` +
                    `no second record was created. Change a field to update ${duplicate.id}, use it as it is ` +
                    `(invoice_create {client: "${duplicate.id}", ...}), or remove it with client_delete {client: "${duplicate.id}"}.`);
            }
            const existing = clients.find((c) => c.name.toLowerCase() === a.name.trim().toLowerCase());
            if (existing) {
                existing.address = a.address ?? existing.address;
                existing.email = a.email ?? existing.email;
                existing.vat_id = a.vat_id ?? existing.vat_id;
                setClients(clients);
                return ok(`Updated client ${existing.name} (${existing.id}).`);
            }
            const c = {
                id: randomBytes(4).toString("hex"), name: a.name.trim(),
                address: a.address, email: a.email, vat_id: a.vat_id, created: isoDate(),
            };
            clients.push(c);
            setClients(clients);
            return ok(`Added client ${c.name} (${c.id}).`);
        });
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
/**
 * D-R97. Every document in this repo that can point back at a client in THIS store, read
 * from the store that owns it. Read-only and best-effort, the same shape as
 * `creditedMinorFor`: a sibling server that was never installed, an unreadable file or a
 * row with the wrong shape all count as "no reference", never as an error - client_delete
 * must still answer on a machine where only mcp-invoice is installed.
 *
 * Invoices in THIS server's own invoices.json are checked separately, not here.
 */
const CLIENT_REFERENCES = [
    { product: "quotes", file: "quotes.json", label: "quote",
        id: (r) => r.id, refs: (r) => [r.client_id, r.client?.name] },
    { product: "billing-docs", file: "credit-notes.json", label: "credit note",
        id: (r) => r.id, refs: (r) => [r.client_id, r.client?.name] },
    { product: "billing-docs", file: "purchase-orders.json", label: "purchase order",
        id: (r) => r.id, refs: (r) => [r.supplier_client_id, r.supplier?.name] },
    { product: "deposits", file: "deposits.json", label: "deposit",
        id: (r) => r.id, refs: (r) => [r.client_id, r.client?.name] },
    { product: "statement-of-account", file: "statements.json", label: "statement",
        id: (r) => r.id, refs: (r) => [r.client_id, r.client_name] },
    { product: "recurring", file: "schedules.json", label: "recurring schedule",
        id: (r) => r.id, refs: (r) => [r.client] },
];
function peekRows(product, file) {
    try {
        const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
        const p = join(base, "mcp-servers", product, file);
        if (!existsSync(p))
            return [];
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (!Array.isArray(raw))
            return [];
        return raw.filter((r) => !!r && typeof r === "object");
    }
    catch {
        return [];
    }
}
/** Everything that still points at this client, this server's own invoices first. */
function dependentsOf(c) {
    const id = c.id.toLowerCase();
    const name = normText(c.name);
    const hits = (values) => values.some((v) => {
        const s = String(v ?? "").trim();
        return s.length > 0 && (s.toLowerCase() === id || normText(s) === name);
    });
    const out = [];
    for (const inv of getInvoices()) {
        if (hits([inv.client_id, inv.client?.name]))
            out.push(`invoice ${inv.number}`);
    }
    for (const src of CLIENT_REFERENCES) {
        for (const row of peekRows(src.product, src.file)) {
            if (!hits(src.refs(row)))
                continue;
            const rowId = String(src.id(row) ?? "").trim();
            out.push(`${src.label} ${rowId || "(no id)"}`);
        }
    }
    return out;
}
/** Exact id, then exact name, then a partial name only when it is unambiguous. */
function resolveForDelete(ref) {
    const clients = getClients();
    const needle = normText(ref);
    const byId = clients.find((c) => c.id.toLowerCase() === ref.trim().toLowerCase());
    if (byId)
        return { client: byId };
    const exact = clients.filter((c) => normText(c.name) === needle);
    const pool = exact.length ? exact : clients.filter((c) => needle.length > 0 && normText(c.name).includes(needle));
    if (!pool.length) {
        return { error: `no client matches "${ref}". Nothing was deleted. client_list shows every stored client with its id.` };
    }
    if (pool.length > 1) {
        return {
            error: `"${ref}" matches more than one client: ${pool.map((c) => `${c.name} (${c.id})`).join(", ")}. ` +
                `Nothing was deleted. Pass the exact id.`,
        };
    }
    return { client: pool[0] };
}
server.registerTool("client_delete", { annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    title: "Delete a client",
    description: "Delete one stored client that nothing refers to. A client named on any invoice, quote, credit note, purchase order, deposit, statement or schedule is refused with those documents listed.",
    inputSchema: {
        client: z.string().describe("Client name or id, exactly as client_list shows it"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const resolved = resolveForDelete(a.client);
            if (resolved.error)
                return fail(resolved.error);
            const target = resolved.client;
            const deps = dependentsOf(target);
            if (deps.length) {
                const shown = deps.slice(0, 10).join(", ");
                return fail(`client ${target.name} (${target.id}) is still used by ${deps.length} ` +
                    `document${deps.length === 1 ? "" : "s"}: ${shown}${deps.length > 10 ? ", ..." : ""}. Nothing was deleted. ` +
                    `An issued invoice is a document the client has seen - credit it rather than deleting the client it bills. ` +
                    `Only a client with no invoice, quote, credit note, purchase order, deposit, statement or recurring schedule can be removed.`);
            }
            const clients = getClients().filter((c) => c.id !== target.id);
            setClients(clients);
            return ok(`Deleted client ${target.name} (${target.id}). Nothing referenced it, so no document changed. ` +
                `${clients.length} client${clients.length === 1 ? "" : "s"} left.\n\n` +
                `The client list itself is unmetered on free and on Pro, so this frees the stored record and the name ` +
                `for reuse; the free cap of ${FREE_INVOICES_PER_MONTH} invoices per calendar month counts invoices only, ` +
                `and invoice_list shows what already counted against it.`);
        });
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
server.registerTool("client_list", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "List clients", description: "List every stored client with id, address, email and VAT id. No arguments, and it writes nothing. With none stored it says so: invoice_create also creates a client from the name you pass.",
    inputSchema: {},
}, async () => {
    const clients = getClients();
    // D-R85: an empty list reads as "nothing exists, ask before writing". invoice_from_hours
    // already creates a client on the fly from the name it is given, so nothing here should
    // buy a confirmation question for a fact the caller already stated.
    if (!clients.length) {
        return ok("No clients yet. client_add creates one explicitly, or invoice_from_hours and " +
            "invoice_create make one automatically from the client name you pass - no setup needed.");
    }
    return json(clients);
});
/* ------------------------------------------------------------------ invoices */
// Amounts are bounded so a line can never produce Infinity/NaN minor units and
// persist an invoice whose totals serialize to null.
const MAX_AMOUNT = 1e12;
const amount = (what) => z.number().finite().min(-MAX_AMOUNT, `${what} is out of range`).max(MAX_AMOUNT, `${what} is out of range`);
const rate = z.number().finite().min(-100).max(1000).optional();
const itemSchema = z.object({
    description: z.string(),
    quantity: amount("quantity").describe("Hours, units or 1 for a flat fee"),
    unit_price: amount("unit_price").describe("Price per unit in major units, e.g. 90 for 90 EUR"),
    tax_rate: rate.describe("VAT percent for this line, overrides the business default"),
    vat_rate: rate.describe("Alias for tax_rate"),
    vat: rate.describe("Alias for tax_rate"),
    // D-R14: a line may carry the currency it was captured in (expense_to_invoice emits it).
    // It is NOT silently ignored: mixing currencies on one invoice is refused below.
    currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional()
        .describe("Currency this line was captured in. Every line on one invoice must agree; convert first with expense_to_invoice target_currency + fx_rates"),
    // D-R46: when unit_price carries sub-cent precision (typically an fx conversion done
    // before calling this tool), the default basis rounds the unit to a whole cent and
    // multiplies, which can drift a cent or two from the exact converted amount - see
    // rounding_note in the response. round_total asks for the line gross to equal the
    // exact converted total to the cent instead; unit_price is then reported, not used
    // to compute the gross.
    round_total: z.boolean().optional()
        .describe("D-R46: round this line's TOTAL to the exact converted amount instead of rounding the unit price to cents first. Default false keeps the D-R24 basis (unit price x quantity always equals the printed gross); true trades that off so the gross matches an fx conversion to the cent."),
    // D-R7: an item's rate must not vanish because the caller spelled it vat_rate.
}).transform((i) => ({
    description: i.description, quantity: i.quantity, unit_price: i.unit_price,
    tax_rate: i.tax_rate ?? i.vat_rate ?? i.vat,
    currency: i.currency ? i.currency.toUpperCase() : undefined,
    round_total: i.round_total === true,
}));
/**
 * D-R14: one invoice carries one currency. Before this, a line that arrived carrying
 * currency "EUR" was billed under the invoice's USD heading with no conversion and no
 * warning. Refuse, and name the argument that fixes it.
 */
function itemCurrencyConflict(items, invoiceCurrency) {
    const seen = [...new Set(items.map((i) => i.currency).filter((c) => !!c))];
    if (!seen.length)
        return null;
    const advice = (codes, target) => `one invoice carries one currency and nothing here converts on its own. Convert first: ` +
        `expense_to_invoice {project: "...", from: "...", to: "...", target_currency: "${target}", ` +
        `fx_rates: {${codes.filter((c) => c !== target).map((c) => `"${c}": <1 ${c} in ${target}>`).join(", ")}}} ` +
        `- 1 unit of that currency = X units of ${target} - then pass that single group's items here. ` +
        `Or issue one invoice per currency.`;
    if (seen.length > 1)
        return `the items mix currencies (${seen.join(", ")}): ` + advice(seen, seen[0]);
    if (seen[0] !== invoiceCurrency) {
        return `the items are in ${seen[0]} but the invoice currency is ${invoiceCurrency}: ` + advice([seen[0], invoiceCurrency], invoiceCurrency);
    }
    return null;
}
function monthLimitBlocked(issueDate) {
    if (gate.isPro())
        return null;
    const used = invoicesInMonth(issueDate.slice(0, 7)).length;
    if (used < FREE_INVOICES_PER_MONTH)
        return null;
    return `You have already created ${used} invoices in ${issueDate.slice(0, 7)}. ` +
        `The free tier allows ${FREE_INVOICES_PER_MONTH} invoices per calendar month.\n\n` +
        gate.upgradeText("unlimited invoices");
}
function createInvoice(a) {
    if (!a.items.length)
        return { error: "an invoice needs at least one item." };
    // D-R2: no business profile is not a reason to lose the work. Issue the document
    // with a placeholder issuer and say so in the response.
    const noBusiness = businessMissing();
    const biz = issuer();
    let client = findClient(a.client);
    let clientCreated = false;
    if (!client) {
        const clients = getClients();
        client = { id: randomBytes(4).toString("hex"), name: a.client.trim(), created: isoDate() };
        clients.push(client);
        setClients(clients);
        clientCreated = true;
    }
    const issue = a.issue_date ?? isoDate();
    // Shape and calendar validity are both checked here, before nextNumber() is
    // called: a date like 2026-13-45 passes the regex but throws later in
    // addDays(), which would burn an invoice number and leave a gap.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(issue) || !Number.isFinite(Date.parse(`${issue}T00:00:00Z`))
        || new Date(`${issue}T00:00:00Z`).toISOString().slice(0, 10) !== issue) {
        return { error: `issue_date must be a real calendar date as YYYY-MM-DD, got "${issue}".` };
    }
    if (typeof a.due_days === "number" && !Number.isInteger(a.due_days)) {
        return { error: `due_days must be a whole number of days, got ${a.due_days}.` };
    }
    const gated = monthLimitBlocked(issue);
    if (gated)
        return { gated };
    const itemCurrencies = [...new Set(a.items.map((i) => i.currency).filter((c) => !!c))];
    // With no explicit invoice currency, a single agreed item currency is the invoice's.
    const currency = (a.currency ?? (itemCurrencies.length === 1 ? itemCurrencies[0] : biz.default_currency)).toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency))
        return { error: `currency must be a 3-letter ISO code such as EUR or USD, got "${currency}".` };
    const clash = itemCurrencyConflict(a.items, currency);
    if (clash)
        return { error: clash };
    const totals = computeTotals(a.items, currency, a.discount_percent ?? 0, biz.default_tax_rate);
    // Guard against a total that has left the exactly-representable integer range;
    // past this point the printed lines and the stored minor units can disagree.
    if (!Number.isSafeInteger(totals.total_minor)) {
        return { error: "the invoice total is too large to represent exactly. Split it into smaller invoices." };
    }
    const number = nextNumber(biz.invoice_prefix, issue.slice(0, 4));
    const inv = {
        number, client_id: client.id,
        client: { name: client.name, address: client.address, email: client.email, vat_id: client.vat_id },
        issue_date: issue,
        due_date: addDays(issue, a.due_days ?? biz.payment_terms_days),
        currency, decimals: totals.decimals, lines: totals.lines,
        subtotal_minor: totals.subtotal_minor,
        discount_percent: totals.discount_percent, discount_minor: totals.discount_minor,
        net_minor: totals.net_minor, tax_lines: totals.tax_lines, tax_minor: totals.tax_minor,
        total_minor: totals.total_minor,
        rounding_drift_minor: totals.rounding_drift_minor,
        notes: a.notes, status: "unpaid", paid_minor: 0,
        created: new Date().toISOString(), branded: !gate.isPro(),
    };
    const all = getInvoices();
    all.push(inv);
    setInvoices(all);
    // The BILL TO block on the PDF is the first thing a client's accounts
    // department reads. Say so when it will only carry a bare name (D-8).
    const clientNote = !client.address
        ? `Note: the BILL TO block will show only "${client.name}" - ` +
            (clientCreated
                ? `that client did not exist yet and was created from the name alone, with no address. `
                : `that client has no address stored. `) +
            `Add one with client_add {name: "${client.name}", address: "...", email: "...", vat_id: "..."} and render the PDF again, ` +
            `so the invoice carries a complete billing address.`
        : undefined;
    return { invoice: inv, clientNote, businessNote: noBusiness ? NO_BUSINESS_NOTE : undefined };
}
server.registerTool("invoice_create", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Create an invoice",
    description: "Create an invoice from line items and return the record with its next, never-reused number. unit_price is in MAJOR units; lines are rounded then summed. One currency per invoice. Free: 3 a month.",
    inputSchema: {
        client: z.string().describe("Client name or id. Unknown names are added automatically"),
        items: z.array(itemSchema).describe("Line items. Amounts are held as integer minor units and every line is rounded first, then summed, so the printed lines can never disagree with the total. A line may carry its own currency"),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional().describe("Invoice currency, 3-letter ISO code. Defaults to the one currency every item agrees on, else your business default. Every line on one invoice must agree with it; a mix is refused with the exact conversion argument to pass rather than billed as if it were one currency"),
        issue_date: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
        due_days: z.number().optional().describe("Days until due, defaults to your payment terms"),
        notes: z.string().optional().describe("Free text printed under the totals"),
        discount_percent: z.number().finite().min(0).max(100).optional().describe("Discount percent applied to every line before tax, 0-100"),
    },
}, async (a) => {
    try {
        const r = await locked(() => createInvoice(a));
        if (r.error)
            return fail(r.error);
        if (r.gated)
            return ok(r.gated);
        return ok(`Created invoice ${r.invoice.number}.\n\n` +
            `${JSON.stringify({ ...summarize(r.invoice), lines: lineRows(r.invoice) }, null, 2)}\n\n` +
            `Amounts are integer minor units: each line was rounded first and then summed, so the total always agrees with the printed lines. ` +
            `Every line on this invoice is in ${r.invoice.currency}; to bill a line in another currency, convert it yourself and pass the converted unit_price.\n\n` +
            `Render it with invoice_pdf.${roundingNote(r.invoice) ? `\n\n${roundingNote(r.invoice)}` : ""}${r.businessNote ? `\n\n${r.businessNote}` : ""}${r.clientNote ? `\n\n${r.clientNote}` : ""}`);
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
server.registerTool("invoice_from_hours", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Invoice from hours",
    description: "Shortcut for the common case: bill one client for N hours at an hourly rate. Creates and returns a single-line invoice, converting the rate into target_currency when you supply fx_rates, and echoing back any entry_ids.",
    inputSchema: {
        client: z.string(),
        hours: amount("hours"),
        rate: amount("rate").describe("Hourly rate in major units, expressed in currency (or the business default currency)"),
        description: z.string().optional().describe("Line description, default 'Consulting services'"),
        tax_rate: z.number().finite().min(-100).max(1000).optional(),
        currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as EUR").optional().describe("Currency the rate is in. Without target_currency this is also the invoice currency"),
        target_currency: z.string().regex(/^[A-Za-z]{3}$/, "must be a 3-letter ISO code such as USD").optional().describe('Issue the invoice in this currency instead, converting the rate. Needs fx_rates for the rate currency'),
        fx_rates: z.record(z.string(), z.number().finite().positive()).optional().describe('Conversion rates, the same pair expense_to_invoice takes: fx_rates maps the RATE\'s currency to the number of target units one of it buys, meaning 1 unit of that currency = X units of target_currency, e.g. {"EUR": 1.1578} with target_currency "USD". You supply the rate; nothing here fetches or guesses one'),
        entry_ids: z.array(z.string()).optional().describe("Time-tracker entry ids these hours came from (the entry_ids invoice_summary returns). Echoed back with the new invoice number so you can call entry_mark_billed"),
        issue_date: z.string().optional(),
        due_days: z.number().optional(),
        notes: z.string().optional(),
        discount_percent: z.number().finite().min(0).max(100).optional(),
        round_total: z.boolean().optional()
            .describe("D-R46: when converting with fx_rates, round the line's TOTAL to the exact converted amount instead of rounding the hourly rate to cents first. Default false keeps the D-R24 basis (unit price x hours always equals the printed line, so a rounding_note explains any drift from the exact conversion); true removes the drift but unit_price x hours may then be a cent or two off the printed total."),
    },
}, async (a) => {
    try {
        // D-R28: same FX semantics as expense_to_invoice, so hours and receipts convert the
        // same way. The source currency is the rate's currency; the invoice is issued in
        // target_currency, and the line says where its unit price came from.
        const source = (a.currency ?? getBusiness().default_currency ?? "EUR").toUpperCase();
        const target = a.target_currency ? a.target_currency.toUpperCase() : undefined;
        if (a.fx_rates && !target) {
            return fail(`fx_rates needs target_currency as well: a rate of 1.1578 means nothing until you say 1.1578 of WHAT. Pass target_currency: "USD" with it.`);
        }
        let unitPrice = a.rate;
        let description = a.description ?? "Consulting services";
        let fxUsed = null;
        if (target && target !== source) {
            const fx = a.fx_rates?.[source] ?? a.fx_rates?.[source.toLowerCase()];
            if (typeof fx !== "number" || !Number.isFinite(fx) || fx <= 0) {
                return fail(`no rate for ${source}. Pass fx_rates with one entry, meaning 1 ${source} = X ${target}: ` +
                    `invoice_from_hours {client: ${JSON.stringify(a.client)}, hours: ${a.hours}, rate: ${a.rate}, currency: "${source}", ` +
                    `target_currency: "${target}", fx_rates: {"${source}": <rate>}}. Nothing here fetches or guesses a rate.`);
            }
            fxUsed = fx;
            unitPrice = a.rate * fx;
            description = `${description} [converted from ${formatMoney(toMinor(a.rate, source), source)}/h at ${fx}]`;
        }
        const r = await locked(() => createInvoice({
            client: a.client,
            items: [{
                    description,
                    quantity: a.hours, unit_price: unitPrice, tax_rate: a.tax_rate, currency: undefined,
                    round_total: a.round_total === true,
                }],
            currency: target ?? a.currency, issue_date: a.issue_date, due_days: a.due_days,
            notes: a.notes, discount_percent: a.discount_percent,
        }));
        if (r.error)
            return fail(r.error);
        if (r.gated)
            return ok(r.gated);
        const ids = a.entry_ids ?? [];
        // D-S1: the fx direction contract is actionable at call time, so the response
        // states it as well as the fx_rates argument description.
        const fxLine = fxUsed !== null
            ? `\n\nfx_rates is directional: {${JSON.stringify(source)}: ${fxUsed}} means 1 ${source} = ${fxUsed} ${target}, the number of ${target} units one ${source} buys, so the rate was multiplied by it. It is the same pair expense_to_invoice takes, and nothing here fetches or guesses a rate.`
            : "";
        const closeLine = ids.length
            ? `\n\nThese hours are still open in the time tracker. Call entry_mark_billed {ids: ${JSON.stringify(ids)}, invoice_number: "${r.invoice.number}"} now, or the same hours appear on the next invoice.`
            : `\n\nIf these hours came from the time tracker, call entry_mark_billed {ids: <entry_ids from invoice_summary>, invoice_number: "${r.invoice.number}"} so they are not billed twice.`;
        return ok(`Created invoice ${r.invoice.number}.\n\n` +
            `${JSON.stringify({
                ...summarize(r.invoice),
                lines: lineRows(r.invoice),
                rate_currency: source,
                target_currency: target ?? null,
                fx_rate_used: fxUsed,
                entry_ids: ids,
            }, null, 2)}` +
            fxLine +
            closeLine +
            `${roundingNote(r.invoice) ? `\n\n${roundingNote(r.invoice)}` : ""}` +
            `${r.businessNote ? `\n\n${r.businessNote}` : ""}` +
            `${r.clientNote ? `\n\n${r.clientNote}` : ""}`);
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
server.registerTool("invoice_list", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "List invoices",
    description: "List invoices by number: client, dates, currency, subtotal, discount, tax lines, total, status, paid, credited and the balance still due after any credit note. Filter by status, client and date range.",
    inputSchema: {
        status: z.enum(["unpaid", "paid", "partial"]).optional(),
        client: z.string().optional(),
        from: z.string().optional().describe("YYYY-MM-DD inclusive"),
        to: z.string().optional().describe("YYYY-MM-DD inclusive"),
    },
}, async (a) => {
    try {
        let list = getInvoices();
        if (a.status)
            list = list.filter((i) => i.status === a.status);
        if (a.client) {
            const n = a.client.trim().toLowerCase();
            list = list.filter((i) => i.client.name.toLowerCase().includes(n) || i.client_id === a.client);
        }
        if (a.from)
            list = list.filter((i) => i.issue_date >= a.from);
        if (a.to)
            list = list.filter((i) => i.issue_date <= a.to);
        if (!list.length)
            return ok("No invoices match.");
        list.sort((x, y) => x.number.localeCompare(y.number));
        return json({ count: list.length, invoices: list.map(summarize) });
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
server.registerTool("invoice_get", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "Get one invoice",
    description: "Return the full stored record for one invoice number, including every line, tax breakdown, and the balance still open after any credit note issued against it (see credited_minor).",
    inputSchema: { number: z.string() },
}, async (a) => {
    const inv = getInvoices().find((i) => i.number === a.number);
    if (!inv)
        return fail(`no invoice numbered ${a.number}.`);
    // D-R96: total_minor and paid_minor alone say nothing about a credit note issued
    // against this invoice in the billing-docs store. credited_minor and open_minor are
    // the netted figures; open_minor is what is actually still owed.
    const { credited_minor, open_minor } = netBalance(inv);
    return json({
        ...inv,
        credited_minor,
        credited: credited_minor ? formatMoney(credited_minor, inv.currency) : undefined,
        open_minor,
        open: formatMoney(open_minor, inv.currency),
    });
});
server.registerTool("invoice_mark_paid", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Mark an invoice paid",
    description: "Record a payment on one invoice. amount is in MAJOR units and ADDS to what is paid, never replaces it; omit it to settle the rest. An overpayment is refused, naming the open balance.",
    inputSchema: {
        number: z.string(),
        paid_date: z.string().optional().describe("YYYY-MM-DD, defaults to today"),
        amount: z.number().finite().positive().optional()
            .describe("Amount received in major units, ADDED to what is already paid on this invoice. Omit to pay off the remaining balance in full"),
        method: z.string().optional().describe("How it was paid, e.g. bank transfer, card. Stored on this payment's row"),
        reference: z.string().optional().describe("Bank reference or transaction id for this payment. Stored on this payment's row"),
    },
}, async (a) => {
    try {
        return await locked(() => {
            const all = getInvoices();
            const inv = all.find((i) => i.number === a.number);
            if (!inv)
                return fail(`no invoice numbered ${a.number}.`);
            const f = Math.pow(10, inv.decimals);
            const already = inv.paid_minor ?? 0;
            const open = inv.total_minor - already;
            const date = a.paid_date ?? isoDate();
            // D-R87: invoice_mark_paid used to SET paid_minor. Two partial payments of
            // 200 then 300 on a EUR 1,000 invoice left paid_minor 30000 and silently lost
            // the first payment (docs/DEPOSITS_RESULT.md). It now ADDS, the same way
            // deposit_apply already does on this same field.
            let addMinor;
            if (a.amount === undefined) {
                if (open <= 0) {
                    return ok(`${inv.number} is already ${inv.status} in full: ` +
                        `${formatMoney(already, inv.currency)} of ${formatMoney(inv.total_minor, inv.currency)} received. Nothing was added.`);
                }
                addMinor = open;
            }
            else {
                addMinor = Math.round(a.amount * f);
                if (addMinor > open) {
                    return fail(`${inv.number} owes ${formatMoney(open, inv.currency)} ` +
                        `(${formatMoney(already, inv.currency)} of ${formatMoney(inv.total_minor, inv.currency)} already received); ` +
                        `a payment of ${formatMoney(addMinor, inv.currency)} would overpay it by ${formatMoney(addMinor - open, inv.currency)}. ` +
                        `Pass at most ${formatMoney(open, inv.currency)}, or record the extra separately (a new invoice, or a deposit). Nothing was changed.`);
                }
            }
            inv.paid_minor = already + addMinor;
            inv.paid_date = date;
            inv.status = inv.paid_minor >= inv.total_minor ? "paid" : inv.paid_minor > 0 ? "partial" : "unpaid";
            inv.payments = inv.payments ?? [];
            inv.payments.push({ date, amount_minor: addMinor, method: a.method, reference: a.reference });
            setInvoices(all);
            // D-R96: the balance shown here nets any credit note issued against this invoice
            // (billing-docs' credit-notes.json, read best-effort - see creditedMinorFor), the
            // same way statement-of-account already does. inv.status above is unchanged: it
            // still reflects paid_minor vs total_minor only, because a credit note is not a
            // payment.
            const { credited_minor, open_minor } = netBalance(inv);
            return ok(`${inv.number} marked ${inv.status} on ${inv.paid_date}. Added ${formatMoney(addMinor, inv.currency)} ` +
                `(total received ${formatMoney(inv.paid_minor, inv.currency)})` +
                (credited_minor ? `, credited ${formatMoney(credited_minor, inv.currency)}` : "") +
                (open_minor > 0 ? `, balance due ${formatMoney(open_minor, inv.currency)}.` : "."));
        });
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
server.registerTool("invoice_pdf", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "Render invoice PDF",
    description: "Call this tool to write one stored invoice as an A4 PDF and return the path: issuer, BILL TO, dates, items, taxes and totals. Free stamps a credit line and no logo; Pro renders it unbranded with your logo.",
    inputSchema: {
        number: z.string().describe("Invoice number to render, as returned by invoice_create"),
        out_path: z.string().optional().describe("Where to write the PDF; defaults to <data dir>/pdf/<number>.pdf. The page carries the issuer block, the BILL TO client block, dates, an item table with wrapped descriptions, subtotal, discount, one tax line per rate, the total, payment details and notes, and every money value on it carries its currency code. Use a .pdf path: the bytes written are always PDF"),
    },
}, async (a) => {
    try {
        const inv = getInvoices().find((i) => i.number === a.number);
        if (!inv)
            return fail(`no invoice numbered ${a.number}.`);
        const biz = issuer();
        const pro = gate.isPro();
        const out = expandPath(a.out_path ?? join(dataDir(), "pdf", `${inv.number}.pdf`));
        await renderInvoicePdf(inv, biz, out, { branded: !pro, logo: pro });
        let note = "";
        // D-R6: this server always writes PDF bytes, so only an .html out_path could
        // make the wording wrong. Name the file for what it actually contains.
        // D-R2: and say once more that the issuer block is a placeholder.
        let extra = "";
        if (documentLabel(out) !== "PDF invoice") {
            extra += `\n\nNote: ${out} holds PDF bytes despite the .html name. Use a .pdf path.`;
        }
        if (businessMissing())
            extra += `\n\n${NO_BUSINESS_NOTE}`;
        if (!pro) {
            note = `\n\nFree tier: the PDF carries the line "Generated with mcp-invoice by theluckystrike" and no logo. ` +
                gate.upgradeText("unbranded PDFs with your logo", "invoice_pdf");
        }
        else if (biz.logo_path && !existsSync(biz.logo_path)) {
            note = `\n\nNote: logo_path ${biz.logo_path} does not exist, rendered without it.`;
        }
        return ok(`Wrote ${documentLabel(out)} ${out}${note}${extra}`);
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
server.registerTool("overdue_report", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "Overdue report",
    description: "List every invoice not paid in full whose due date has passed, worst first, with days overdue and the amount, then a total per currency. Free. Use invoice_list for everything still open.",
    inputSchema: { as_of: z.string().optional().describe("YYYY-MM-DD, defaults to today") },
}, async (a) => {
    try {
        const today = a.as_of ?? isoDate();
        const rows = getInvoices()
            .filter((i) => i.status !== "paid" && i.due_date < today)
            .map((i) => ({
            number: i.number, client: i.client.name, due_date: i.due_date,
            days_overdue: daysBetween(i.due_date, today),
            outstanding: formatMoney(i.total_minor - i.paid_minor, i.currency),
            outstanding_minor: i.total_minor - i.paid_minor, currency: i.currency,
        }))
            .sort((x, y) => y.days_overdue - x.days_overdue);
        const totals = {};
        for (const r of rows)
            totals[r.currency] = (totals[r.currency] ?? 0) + r.outstanding_minor;
        return json({
            as_of: today, count: rows.length, invoices: rows,
            totals_per_currency: Object.entries(totals).map(([c, v]) => formatMoney(v, c)),
        });
    }
    catch (e) {
        return fail(String(e.message ?? e));
    }
});
/* ----------------------------------------------------------------- resources */
server.registerResource("open-invoices", "invoices://open", {
    title: "Open invoices",
    description: "Every unpaid or partly paid invoice as JSON, with the balance due.",
    mimeType: "application/json",
}, async (uri) => ({
    contents: [{
            uri: uri.href, mimeType: "application/json",
            text: JSON.stringify(getInvoices().filter((i) => i.status !== "paid").map(summarize), null, 2),
        }],
}));
/* ------------------------------------------------------------------- prompts */
server.registerPrompt("monthly_invoicing", {
    title: "Monthly invoicing",
    description: "Review what is unpaid and what is overdue, then draft the next invoice for the client that owes the most.",
    argsSchema: {
        month: z.string().optional().describe("YYYY-MM, default the current month"),
        client: z.string().optional().describe("Limit the review, and the drafted invoice, to one client name or id"),
    },
}, ({ month, client }) => {
    const m = month && /^\d{4}-\d{2}$/.test(month) ? month : isoDate().slice(0, 7);
    const from = `${m}-01`;
    const to = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
    const who = client && client.trim() ? client.trim() : null;
    return {
        messages: [{
                role: "user",
                content: {
                    type: "text",
                    text: [
                        `Run the invoicing round for ${m} (${from} to ${to}) with the invoice tools and report it as one short summary:`,
                        `1. invoice_list {status: "unpaid"}${who ? ` and invoice_list {status: "unpaid", client: ${JSON.stringify(who)}}` : ""} - list every unpaid invoice with its number, client, issue date, due date and amount.`,
                        `2. invoice_list {status: "partial"} - add the part-paid ones, showing the balance still due on each.`,
                        `3. overdue_report {as_of: "${to}"} - name every overdue invoice with its days overdue and outstanding amount, and give the outstanding total per currency. Do not add across currencies.`,
                        `4. Draft the next invoice: invoice_create {client: ${JSON.stringify(who ?? "<client name>")}, items: [{description: "<work>", quantity: 1, unit_price: 0}], issue_date: "${to}"} - or invoice_from_hours {client: ${JSON.stringify(who ?? "<client name>")}, hours: 0, rate: 0, issue_date: "${to}"} when it is billed by the hour. Ask me for the real line items and rate before you call either one.`,
                        `5. Render whatever you created with invoice_pdf {number: "<the number invoice_create returned>"} and give me the file path.`,
                    ].join("\n"),
                },
            }],
    };
});
gate.registerTools(server);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`mcp-invoice ready (${gate.isPro() ? "pro" : "free"}), data in ${dataDir()}\n`);
