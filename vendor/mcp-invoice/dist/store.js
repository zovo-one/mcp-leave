import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { profilePath, readSharedProfile, writeSharedProfile } from "@theluckystrike/mcp-license";
export function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "mcp-servers", "invoice");
    mkdirSync(dir, { recursive: true });
    return dir;
}
/**
 * Codex v3 #1 (P0). A read or JSON.parse failure must never be reported as "empty
 * database": the next mutation would then overwrite a history that is still on disk.
 * Only ENOENT means empty. A parse failure quarantines the file byte-for-byte as
 * <file>.corrupt-<timestamp>, writes a marker so every later call (read or write)
 * keeps failing until a human resolves it, and throws.
 */
export class CorruptDataError extends Error {
}
export function markerPath(file) { return `${file}.corrupt`; }
function corruptStamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function blocked(file, moved) {
    return new CorruptDataError(`data file is corrupt; moved to ${moved}; nothing was written. ` +
        `Restore a good copy to ${file}, then delete ${markerPath(file)} to continue.`);
}
export function readJsonFile(file, empty) {
    const marker = markerPath(file);
    if (existsSync(marker)) {
        let moved = `${file}.corrupt-*`;
        try {
            const t = readFileSync(marker, "utf8").trim();
            if (t) {
                try {
                    const j = JSON.parse(t);
                    moved = typeof j.quarantined === "string" && j.quarantined ? j.quarantined : t;
                }
                catch {
                    moved = t;
                }
            }
        }
        catch { /* marker unreadable */ }
        throw blocked(file, moved);
    }
    let raw;
    try {
        raw = readFileSync(file, "utf8");
    }
    catch (e) {
        if (e.code === "ENOENT")
            return empty;
        throw new CorruptDataError(`cannot read the data file ${file}: ${e.message}; nothing was written.`);
    }
    try {
        return JSON.parse(raw);
    }
    catch (e) {
        const moved = `${file}.corrupt-${corruptStamp()}`;
        try {
            renameSync(file, moved);
            writeFileSync(marker, JSON.stringify({ quarantined: moved, at: new Date().toISOString(), hint: "the original data file failed to parse; it was moved, nothing was overwritten; restore it manually or delete this marker to start fresh" }) + "\n");
        }
        catch { /* keep the parse error */ }
        process.stderr.write(`${file} is not valid JSON (${e.message}); moved to ${moved}\n`);
        throw blocked(file, moved);
    }
}
function readJson(file, fallback) {
    return readJsonFile(join(dataDir(), file), fallback);
}
function writeJson(file, value) {
    const p = join(dataDir(), file);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, p);
}
export const DEFAULT_BUSINESS = {
    name: "", default_currency: "EUR", default_tax_rate: 0,
    payment_terms_days: 14, invoice_prefix: "INV",
};
/**
 * D-R95. `business_set` accepts `vat_rate`, `tax_rate` and `vat` as aliases for
 * `default_tax_rate` and resolves them before it calls `writeSharedProfile`, which only
 * ever persists the canonical `default_tax_rate` key (`writeSharedProfile` whitelists
 * `PROFILE_FIELDS`, so an alias key can never actually land in the file through that
 * path). The gap this covers is a HAND-WRITTEN or hand-edited shared profile: a file at
 * `mcp-servers/profile/business.json` that someone or something else wrote directly with
 * `vat_rate: 23` and no `default_tax_rate` at all. `readSharedProfile`'s own sanitizer
 * whitelists exactly the same canonical fields, so that alias key is dropped before this
 * function ever sees it. Read the raw file ourselves, best-effort, and accept the same
 * aliases `business_set` does, so an invoice created from either kind of profile carries
 * the same rate. Any failure (missing file, corrupt JSON, wrong shape) degrades to
 * undefined, exactly like a profile with no rate at all - it never throws.
 */
function rawSharedTaxRateAlias() {
    try {
        const raw = JSON.parse(readFileSync(profilePath(), "utf8"));
        if (!raw || typeof raw !== "object")
            return undefined;
        for (const k of ["default_tax_rate", "tax_rate", "vat_rate", "vat"]) {
            const v = raw[k];
            if (typeof v === "number" && Number.isFinite(v))
                return v;
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * D-R31. The issuer identity is one fact for the whole suite. The shared profile at
 * mcp-servers/profile/business.json is read first and wins field by field; the local
 * business.json is kept as the compatibility copy and as the fallback when no shared
 * profile exists yet. A field absent from the shared profile never blanks a local one.
 */
export function getBusiness() {
    const local = readJson("business.json", {});
    const shared = readSharedProfile();
    const fromShared = {};
    if (shared.name)
        fromShared.name = shared.name;
    if (shared.address)
        fromShared.address = shared.address;
    if (shared.email)
        fromShared.email = shared.email;
    if (shared.vat_id)
        fromShared.vat_id = shared.vat_id;
    if (shared.iban)
        fromShared.iban = shared.iban;
    if (shared.bank)
        fromShared.bank = shared.bank;
    if (shared.logo_path)
        fromShared.logo_path = shared.logo_path;
    if (shared.default_currency)
        fromShared.default_currency = shared.default_currency;
    // D-R95: default_tax_rate first; a hand-written profile that instead used one of the
    // aliases business_set accepts is not silently read as "no rate".
    if (typeof shared.default_tax_rate === "number")
        fromShared.default_tax_rate = shared.default_tax_rate;
    else {
        const alias = rawSharedTaxRateAlias();
        if (typeof alias === "number")
            fromShared.default_tax_rate = alias;
    }
    if (typeof shared.payment_terms_days === "number")
        fromShared.payment_terms_days = shared.payment_terms_days;
    if (shared.invoice_prefix)
        fromShared.invoice_prefix = shared.invoice_prefix;
    return { ...DEFAULT_BUSINESS, ...local, ...fromShared };
}
/** Writes the shared profile as well, so docx, expense-tracker and recurring see it. */
export function setBusiness(b) {
    writeJson("business.json", b);
    writeSharedProfile(b);
}
export function hasBusiness() {
    return existsSync(join(dataDir(), "business.json")) || !!readSharedProfile().name;
}
export function getClients() { return readJson("clients.json", []); }
export function setClients(c) { writeJson("clients.json", c); }
export function getInvoices() { return readJson("invoices.json", []); }
export function setInvoices(i) { writeJson("invoices.json", i); }
/**
 * Allocate the next invoice number: <prefix>-<YYYY>-<NNNN>.
 * The counter file is written before the invoice is stored, so a crash burns a number
 * rather than reusing one. Existing invoice numbers are also scanned so a restored or
 * hand-edited invoices.json can never hand back a number that is already on a document.
 */
export function nextNumber(prefix, year) {
    const counters = readJson("counter.json", {});
    const key = `${prefix}-${year}`;
    let n = counters[key] ?? 0;
    const used = new Set(getInvoices().map((i) => i.number));
    do {
        n += 1;
    } while (used.has(`${key}-${String(n).padStart(4, "0")}`));
    counters[key] = n;
    writeJson("counter.json", counters);
    return `${key}-${String(n).padStart(4, "0")}`;
}
export function findClient(ref) {
    const clients = getClients();
    const needle = ref.trim().toLowerCase();
    return clients.find((c) => c.id === ref) ?? clients.find((c) => c.name.toLowerCase() === needle)
        ?? clients.find((c) => c.name.toLowerCase().includes(needle));
}
export function invoicesInMonth(month) {
    return getInvoices().filter((i) => i.issue_date.slice(0, 7) === month);
}
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
export function creditedMinorFor(invoiceNumber, currency) {
    try {
        const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
        const p = join(base, "mcp-servers", "billing-docs", "credit-notes.json");
        if (!existsSync(p))
            return 0;
        const raw = JSON.parse(readFileSync(p, "utf8"));
        if (!Array.isArray(raw))
            return 0;
        const norm = (s) => String(s ?? "").trim().toLowerCase();
        const wantNumber = norm(invoiceNumber);
        const wantCurrency = currency.toUpperCase();
        let credited = 0;
        for (const c of raw) {
            if (!c || typeof c !== "object")
                continue;
            if (norm(c.invoice_number) !== wantNumber)
                continue;
            if (String(c.currency ?? "").toUpperCase() !== wantCurrency)
                continue;
            if (typeof c.total_minor !== "number" || !Number.isFinite(c.total_minor))
                continue;
            credited -= c.total_minor;
        }
        return credited;
    }
    catch {
        return 0;
    }
}
