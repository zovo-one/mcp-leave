/**
 * D-R31. One business profile for the whole suite.
 *
 * Round 8 measured the cost of not having this: a freelancer states "I am X in Warsaw,
 * VAT PL..., EUR, 23%, 14-day terms" once, and eleven servers each decide separately what
 * to do about it. invoice kept the VAT rate, docx had no letterhead, expense-tracker had no
 * default rate, time-tracker did not know the zone. This file is the single place that fact
 * lives; every server reads it first and falls back to its own local copy.
 *
 * Location: ${XDG_DATA_HOME:-~/.local/share}/mcp-servers/profile/business.json
 */
export interface SharedProfile {
    name?: string;
    address?: string;
    email?: string;
    phone?: string;
    vat_id?: string;
    iban?: string;
    bank?: string;
    default_currency?: string;
    default_tax_rate?: number;
    payment_terms_days?: number;
    invoice_prefix?: string;
    timezone?: string;
    /**
     * D-R48. Set to "inferred from address" when timezone was not given explicitly and
     * was worked out from the address instead. Absent when timezone came from the caller.
     */
    timezone_source?: string;
    logo_path?: string;
    /** ISO timestamp of the last write. Informational only. */
    updated?: string;
}
export declare const PROFILE_FIELDS: readonly ["name", "address", "email", "phone", "vat_id", "iban", "bank", "default_currency", "default_tax_rate", "payment_terms_days", "invoice_prefix", "timezone", "timezone_source", "logo_path"];
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export declare function profileDir(): string;
export declare function profilePath(): string;
/**
 * Read the shared profile. Never throws: identity is read on paths that must still work
 * (rendering an invoice, stamping a timer), so a missing or unreadable file degrades to
 * "no profile" rather than taking a tool down. A file that is present but not JSON is
 * quarantined byte-for-byte as business.json.corrupt-<ts> with a marker beside it, so a
 * later writeSharedProfile cannot silently overwrite a profile that is still on disk.
 */
export declare function readSharedProfile(): SharedProfile;
/**
 * Merge `patch` into the shared profile and write it atomically (tmp + rename, per-process
 * temp name so two servers writing at once cannot clobber one another's temp file).
 * Keys whose value is undefined are ignored; an explicit null clears the field.
 * Returns the profile as it now stands on disk.
 */
export declare function writeSharedProfile(patch: Record<string, unknown>): SharedProfile;
/** True when the shared profile carries a usable business name. */
export declare function hasSharedProfile(): boolean;
/**
 * D-R40. An email is only ever the shared profile's or an explicit argument. When neither
 * exists a document prints this marker instead of an address a model improvised.
 */
export declare const EMAIL_PLACEHOLDER = "[add: email]";
export declare function resolveEmail(explicit?: string): {
    email: string;
    missing: boolean;
};
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
export declare function inferTimezoneFromAddress(address: string): {
    zone: string;
    matched: string;
} | undefined;
