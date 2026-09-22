/**
 * City and country names -> IANA time zones.
 *
 * Written as data, not derived from the zone ids, because a user says "Warsaw" or
 * "India", not "Europe/Warsaw" or "Asia/Kolkata". Every entry is verified at startup
 * against Intl.supportedValuesOf("timeZone"); an entry naming a zone this Node build
 * does not know is dropped with one stderr line rather than silently resolving wrong.
 *
 * A country with a single zone maps to it. A country with several zones maps to the
 * zone of its largest population centre (documented in README): "United States" ->
 * America/New_York, "Australia" -> Australia/Sydney. Ambiguity is resolved toward the
 * most common business zone, never guessed per call.
 */
/** name (lowercase, no punctuation) -> IANA zone */
export declare const RAW_PLACES: Record<string, string>;
/**
 * V4-6: a fixed abbreviation is an OFFSET, not a place. "EST" is UTC-05:00 all year;
 * mapping it to America/New_York returned EDT (UTC-04:00) every summer, an hour wrong
 * for half the year with nothing in the answer to show it. Each entry therefore maps to
 * a fixed-offset zone and carries a note that names the place to pass instead.
 */
export interface FixedAbbrev {
    zone: string;
    note: string;
}
export declare const FIXED_ABBREV: Record<string, FixedAbbrev>;
