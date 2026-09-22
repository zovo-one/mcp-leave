import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dataDir as invoiceDataDir, hasBusiness, readJsonFile } from "@theluckystrike/mcp-invoice/lib";
export function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    const dir = join(base, "mcp-servers", "quotes");
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function lockPath() { return join(dataDir(), ".lock"); }
function read(file, empty) {
    return readJsonFile(join(dataDir(), file), empty);
}
/** Atomic: per-process temp name, then rename over the target. */
function write(file, value) {
    const p = join(dataDir(), file);
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2));
    renameSync(tmp, p);
}
export function getQuotes() { return read("quotes.json", []); }
export function setQuotes(q) { write("quotes.json", q); }
/**
 * Allocate the next quote id: `Q-<YYYY>-<NNNN>`.
 *
 * The counter is per year and is written BEFORE the quote is stored, so a crash burns an
 * id rather than reusing one. Ids already in the store are also scanned, so a restored or
 * hand-edited quotes.json can never hand back an id that is already on a document a
 * client has seen. The year is part of the id on purpose: a bare `Q-0001` reset every
 * January collides with last January's quote, and the two are different documents.
 */
export function nextQuoteId(year, existing) {
    const counters = read("counter.json", {});
    const key = `Q-${year}`;
    let n = counters[key] ?? 0;
    const used = new Set(existing.map((q) => q.id));
    do {
        n += 1;
    } while (used.has(`${key}-${String(n).padStart(4, "0")}`));
    counters[key] = n;
    write("counter.json", counters);
    return `${key}-${String(n).padStart(4, "0")}`;
}
/**
 * Resolve a quote by exact id (case-insensitive), then by exact client name, then -- only
 * if nothing exact matched -- by partial client name. More than one partial candidate is
 * refused with the list rather than silently picking the first, so quote_accept cannot
 * accept the wrong client's quote.
 */
export function findQuote(list, ref) {
    const needle = String(ref).trim().toLowerCase();
    const byId = list.find((q) => q.id.toLowerCase() === needle);
    if (byId)
        return byId;
    const byClient = list.filter((q) => q.client.name.toLowerCase() === needle);
    if (byClient.length === 1)
        return byClient[0];
    const pool = byClient.length ? byClient : list.filter((q) => q.client.name.toLowerCase().includes(needle));
    if (pool.length > 1) {
        throw new Error(`"${ref}" matches more than one quote: ${pool.map((q) => `${q.id} (${q.client.name}, ${q.status})`).join(", ")}. ` +
            `Pass the exact quote id.`);
    }
    return pool[0];
}
/**
 * Is the invoice server's store actually in use on this machine? True when it already
 * holds invoices, a client list or a business profile. quote_accept uses this to decide
 * between creating the invoice directly and handing back invoice_create-ready items.
 */
export function invoiceStorePresent() {
    const dir = invoiceDataDir();
    return existsSync(join(dir, "invoices.json"))
        || existsSync(join(dir, "clients.json"))
        || hasBusiness();
}
