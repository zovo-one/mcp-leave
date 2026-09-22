import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveZone } from "@theluckystrike/mcp-timezone/lib";
export const PROFILE_FIELDS = [
    "name", "address", "email", "phone", "vat_id", "iban", "bank",
    "default_currency", "default_tax_rate", "payment_terms_days",
    "invoice_prefix", "timezone", "timezone_source", "logo_path",
];
export function profileDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(base, "mcp-servers", "profile");
}
export function profilePath() { return join(profileDir(), "business.json"); }
function markerPath() { return `${profilePath()}.corrupt`; }
/**
 * Read the shared profile. Never throws: identity is read on paths that must still work
 * (rendering an invoice, stamping a timer), so a missing or unreadable file degrades to
 * "no profile" rather than taking a tool down. A file that is present but not JSON is
 * quarantined byte-for-byte as business.json.corrupt-<ts> with a marker beside it, so a
 * later writeSharedProfile cannot silently overwrite a profile that is still on disk.
 */
export function readSharedProfile() {
    const p = profilePath();
    if (existsSync(markerPath()))
        return {};
    let raw;
    try {
        raw = readFileSync(p, "utf8");
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("not an object");
        return sanitize(parsed);
    }
    catch (e) {
        quarantine(p, e.message);
        return {};
    }
}
function quarantine(p, why) {
    const moved = `${p}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try {
        renameSync(p, moved);
        writeFileSync(markerPath(), JSON.stringify({
            quarantined: moved, at: new Date().toISOString(),
            hint: "the shared business profile failed to parse; it was moved, nothing was overwritten; restore it or delete this marker to start fresh",
        }) + "\n");
        process.stderr.write(`shared profile ${p} is not valid JSON (${why}); moved to ${moved}\n`);
    }
    catch { /* read path stays non-fatal */ }
}
/** Drop unknown keys and wrong-typed values rather than letting them reach a document. */
function sanitize(o) {
    const out = {};
    for (const f of PROFILE_FIELDS) {
        const v = o[f];
        if (v === undefined || v === null)
            continue;
        if (f === "default_tax_rate" || f === "payment_terms_days") {
            if (typeof v === "number" && Number.isFinite(v))
                out[f] = v;
        }
        else if (typeof v === "string" && v.trim() !== "") {
            out[f] = v;
        }
    }
    if (typeof o.updated === "string")
        out.updated = o.updated;
    return out;
}
/**
 * Merge `patch` into the shared profile and write it atomically (tmp + rename, per-process
 * temp name so two servers writing at once cannot clobber one another's temp file).
 * Keys whose value is undefined are ignored; an explicit null clears the field.
 * Returns the profile as it now stands on disk.
 */
export function writeSharedProfile(patch) {
    if (existsSync(markerPath())) {
        throw new Error(`the shared business profile is quarantined; restore ${profilePath()} then delete ${markerPath()} to continue`);
    }
    const current = readSharedProfile();
    const next = { ...current };
    for (const f of PROFILE_FIELDS) {
        if (!(f in patch))
            continue;
        const v = patch[f];
        if (v === undefined)
            continue;
        if (v === null || v === "") {
            delete next[f];
            continue;
        }
        next[f] = v;
    }
    const clean = sanitize(next);
    clean.updated = new Date().toISOString();
    const dir = profileDir();
    mkdirSync(dir, { recursive: true });
    const p = profilePath();
    const tmp = `${p}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify(clean, null, 2) + "\n");
        renameSync(tmp, p);
    }
    catch (e) {
        try {
            if (existsSync(tmp))
                unlinkSync(tmp);
        }
        catch { /* ignore */ }
        throw e;
    }
    return clean;
}
/** True when the shared profile carries a usable business name. */
export function hasSharedProfile() {
    return (readSharedProfile().name ?? "").trim() !== "";
}
/**
 * D-R40. An email is only ever the shared profile's or an explicit argument. When neither
 * exists a document prints this marker instead of an address a model improvised.
 */
export const EMAIL_PLACEHOLDER = "[add: email]";
export function resolveEmail(explicit) {
    const given = (explicit ?? "").trim();
    if (given)
        return { email: given, missing: false };
    const stored = (readSharedProfile().email ?? "").trim();
    if (stored)
        return { email: stored, missing: false };
    return { email: EMAIL_PLACEHOLDER, missing: true };
}
/**
 * D-R48. business_set receives an address but no timezone: "I am X in Warsaw" sets an
 * address, and the profile came back with no timezone field at all, although timezone
 * resolves bare place names perfectly well one call later. Infer one from the LAST city
 * or country name in the address, using @theluckystrike/mcp-timezone's place table
 * (the same table `timezone` itself reads for a bare place name such as "Austin").
 *
 * The address is split on commas and newlines and every segment is tried from the LAST
 * one back to the first, so "123 Main St, Austin, TX" tries "TX" (not a place in the
 * table, no match) before "Austin" (matches America/Chicago) - the last segment that IS
 * a recognizable city, state or country wins, not necessarily the literal last segment.
 * A number, a street name or an unrecognized place never matches, so an address that
 * names nothing the table knows infers nothing.
 */
export function inferTimezoneFromAddress(address) {
    const segments = String(address ?? "")
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    for (let i = segments.length - 1; i >= 0; i--) {
        try {
            const hit = resolveZone(segments[i]);
            return { zone: hit.zone, matched: segments[i] };
        }
        catch {
            // not a place this table knows; try the segment before it
        }
    }
    return undefined;
}
