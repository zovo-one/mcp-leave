/** The home zone from the shared profile, or undefined when none is set or it is not real. */
export declare function homeZone(): string | undefined;
/** Test seam: drop the memoised zone after the profile changes inside one process. */
export declare function resetZoneCache(): void;
/** Today on the user's calendar, YYYY-MM-DD. */
export declare function today(now?: Date, zone?: string | undefined): string;
export declare const ISO_DATE: RegExp;
/** True for a well-formed AND real calendar date ("2026-02-30" is neither). */
export declare function isIsoDate(s: unknown): s is string;
