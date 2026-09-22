import { readSharedProfile } from "@theluckystrike/mcp-license";
/**
 * "Today", as the user's calendar sees it.
 *
 * D-R35 (time-tracker) applies here too and costs more: a quote's validity is a date the
 * client is held to. When the shared business profile carries a `timezone`, that is the
 * home zone and today is computed in it, not in the host machine's zone. A quote issued
 * at 00:30 Warsaw on a UTC-05 laptop would otherwise be stamped with the previous day and
 * expire a day early.
 */
let zoneCache = null;
/** The home zone from the shared profile, or undefined when none is set or it is not real. */
export function homeZone() {
    const raw = readSharedProfile().timezone;
    if (zoneCache && zoneCache.raw === raw)
        return zoneCache.zone;
    let zone;
    if (raw) {
        try {
            new Intl.DateTimeFormat("en-CA", { timeZone: raw });
            zone = raw;
        }
        catch {
            zone = undefined;
        }
    }
    zoneCache = { raw, zone };
    return zone;
}
/** Test seam: drop the memoised zone after the profile changes inside one process. */
export function resetZoneCache() { zoneCache = null; }
const p2 = (n) => String(n).padStart(2, "0");
/** Today on the user's calendar, YYYY-MM-DD. */
export function today(now = new Date(), zone = homeZone()) {
    if (zone) {
        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(now);
        const v = {};
        for (const p of parts)
            if (p.type !== "literal")
                v[p.type] = p.value;
        return `${v.year}-${v.month}-${v.day}`;
    }
    return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** True for a well-formed AND real calendar date ("2026-02-30" is neither). */
export function isIsoDate(s) {
    if (typeof s !== "string" || !ISO_DATE.test(s))
        return false;
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
