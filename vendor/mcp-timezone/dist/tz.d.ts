export declare function isValidZone(zone: string): boolean;
/** Every IANA id this Node build knows, plus the modern spellings in the place table. */
export declare function allZones(): string[];
export interface PlaceTable {
    byName: Map<string, string>;
    dropped: string[];
}
/** Verified at startup: an entry naming a zone this build cannot resolve is dropped. */
export declare function buildPlaceTable(): PlaceTable;
export declare const PLACE_COUNT: number;
export declare const DROPPED_PLACES: string[];
export interface ZoneHit {
    zone: string;
    matched: string;
    note?: string;
}
/** A caller-supplied name is echoed back, so it is truncated: a 1 MB argument must not become a 1 MB error. */
export declare function clip(s: string, n?: number): string;
export declare class UnknownZoneError extends Error {
    input: string;
    suggestions: string[];
    constructor(input: string, suggestions: string[]);
}
/** "Warsaw", "poland", "Europe/Warsaw", "PST", "UTC+2" -> an IANA zone. */
export declare function resolveZone(input: string): ZoneHit;
export interface Wall {
    y: number;
    m: number;
    d: number;
    h: number;
    mi: number;
    s: number;
}
/** The wall-clock reading in `zone` at instant `date`. */
export declare function wallIn(date: Date, zone: string): Wall;
/** UTC offset of `zone` at instant `date`, in minutes east of UTC (Asia/Kolkata -> 330). */
export declare function offsetMinutes(date: Date, zone: string): number;
export declare function offsetLabel(mins: number): string;
/** Date.UTC maps years 0-99 onto 1900-1999; this keeps the literal year. */
export declare function utcFromWall(w: Wall): number;
/**
 * V4-4: every field in range AND the UTC round-trip equal to the input. Date.UTC alone
 * rolls 2026-02-30 forward to 2026-03-02 without a word, so one typo silently books a
 * meeting on a different day and every downstream answer is wrong but well-formed.
 */
export declare function assertValidWall(w: Wall, what?: string): Wall;
/** A strict YYYY-MM-DD: "2026-02-30" is refused, never normalised to 2026-03-02. */
export declare function parseIsoDateStrict(s: string, what?: string): Wall;
export type GapPolicy = "forward" | "backward";
export type FoldPolicy = "first" | "second";
export interface WallPolicy {
    gap?: GapPolicy;
    fold?: FoldPolicy;
}
export interface WallResolved {
    date: Date;
    kind: "unique" | "gap" | "fold";
    note?: string;
}
/**
 * Every UTC instant whose wall reading in `zone` is exactly `w`: zero inside a
 * spring-forward gap, two inside an autumn fold, one on every other day. Candidate
 * offsets are taken a day either side of the target, which brackets any transition.
 */
export declare function instantsFor(w: Wall, zone: string): Date[];
/**
 * V4-5: an explicit DST policy. A wall time in a spring-forward gap is refused with the
 * two valid neighbours named, unless the caller passes gap "forward" or "backward". A
 * wall time in an autumn fold returns the FIRST occurrence and says so; fold "second"
 * selects the other. Silence here is what moves a meeting by an hour once a year.
 */
export declare function resolveWall(w: Wall, zone: string, policy?: WallPolicy, what?: string): WallResolved;
/**
 * Wall clock in a zone -> the UTC instant. Internal callers (slot grids, overlap
 * boundaries) walk a calendar and cannot stop on a gap, so the default policy here is
 * gap "forward"; caller-supplied times go through resolveWall with no default, which
 * refuses instead.
 */
export declare function zonedToUtc(w: Wall, zone: string, policy?: WallPolicy): Date;
export declare function dateKey(w: Wall): string;
export declare function timeKey(w: Wall): string;
export declare function weekdayIn(date: Date, zone: string): string;
export declare function zoneAbbrev(date: Date, zone: string): string;
/** "2026-09-10 15:00 Fri (CEST, UTC+02:00)" */
export declare function describe(date: Date, zone: string): string;
export declare function hhmmToMinutes(s: string, what?: string): number;
/**
 * Parse a user time expressed in `zone`. Accepted:
 *   "2026-09-10 15:00", "2026-09-10T15:00", "2026-09-10"        (wall time in `zone`)
 *   "2026-09-10T15:00:00Z", "...+02:00"                          (absolute, zone ignored)
 *   "3pm", "15:00", "3pm tomorrow", "tomorrow 3pm", "monday 9am" (relative to today in `zone`)
 *   "now"
 * Returns the UTC instant.
 */
export interface ParsedTime {
    date: Date;
    resolution?: WallResolved;
}
export declare function parseTimeIn(input: string, zone: string, now?: Date, policy?: WallPolicy): Date;
/** The same parse, with the DST resolution (gap or fold) the caller has to be told about. */
export declare function parseTimeInDetailed(input: string, zone: string, now?: Date, policy?: WallPolicy): ParsedTime;
export interface WorkWindow {
    zone: string;
    startMin: number;
    endMin: number;
}
/**
 * The daily window, in UTC minutes from 00:00 UTC, during which every zone is inside
 * its working hours. Computed on a concrete date because DST moves the answer: the
 * London/New York overlap is one hour wider in the two weeks the two are out of step.
 */
export declare function overlapOnDate(windows: WorkWindow[], dayUtc: Date): {
    startMin: number;
    endMin: number;
} | null;
export interface LocalOverlap {
    startUtc: Date;
    endUtc: Date;
}
/**
 * V4-7: the overlap of working windows that all sit on the SAME LOCAL CALENDAR DATE.
 * Each boundary is built from that local date in its own zone and only then converted
 * to UTC. The old minutes-from-UTC-midnight form answered for whichever UTC day
 * contained local midnight, which for every positive offset is the day before.
 */
export declare function overlapOnLocalDate(windows: WorkWindow[], isoDate: string): LocalOverlap | null;
export interface DstChange {
    atUtc: Date;
    fromOffset: number;
    toOffset: number;
}
/** Every offset transition of `zone` in `year`, found by scan then binary search. */
export declare function dstChanges(zone: string, year: number): DstChange[];
/** The day loop is O(days); a 200-year range used to stop silently at the guard and report a short answer. */
export declare const MAX_BUSINESS_DAY_SPAN = 3700;
export declare function businessDays(from: string, to: string, zone: string, holidays?: string[]): {
    days: string[];
    weekendCount: number;
    holidayCount: number;
    total: number;
};
export interface Participant {
    name: string;
    zone: string;
    startMin: number;
    endMin: number;
}
export interface Slot {
    startUtc: Date;
    endUtc: Date;
    local: {
        name: string;
        zone: string;
        start: string;
        end: string;
        date: string;
    }[];
    fairness: number;
}
/**
 * Every start time on a `stepMinutes` grid where the whole meeting fits inside every
 * participant's working window, ranked by fairness. Fairness is the WORST participant's
 * deviation from 13:00 local, not the average: a slot that is comfortable for two people
 * and 06:00 for the third must not outrank one that is 10:00 for everybody.
 */
export declare function findSlots(participants: Participant[], durationMinutes: number, days: number, firstDayUtc: Date, stepMinutes?: number): Slot[];
export interface NearMissLocal {
    name: string;
    zone: string;
    start: string;
    end: string;
    date: string;
    outsideMinutes: number;
    needStart: string;
    needEnd: string;
}
export interface NearMiss {
    startUtc: Date;
    endUtc: Date;
    outsideMinutes: number;
    local: NearMissLocal[];
}
/**
 * D-R30: when nothing fits, the least-bad times. Ranked by the TOTAL minutes any
 * participant would spend outside their own hours, with the working hours that would
 * make each slot fit. A refusal alone tells the user nothing they can act on.
 */
export declare function findNearMissSlots(participants: Participant[], durationMinutes: number, days: number, firstDayUtc: Date, stepMinutes?: number, limit?: number): NearMiss[];
/** An attendee is a calendar address: mailto:<addr>. A bare name cannot be invited. */
export declare function calendarAddress(raw: string): {
    uri: string;
    cn: string;
};
export declare function icsStamp(d: Date): string;
export interface AttendeeInput {
    name?: string;
    email?: string;
}
export interface IcsInput {
    title: string;
    startUtc: Date;
    durationMinutes: number;
    attendees?: (string | AttendeeInput)[];
    description?: string;
    location?: string;
    uid?: string;
    organizerEmail?: string;
    organizerName?: string;
    now?: Date;
}
export interface IcsResult {
    text: string;
    invited: string[];
    listedOnly: string[];
    organizer?: string;
}
/**
 * A VEVENT with UTC DTSTART/DTEND. Writing the instant in UTC removes the need to ship
 * a VTIMEZONE block, which is where hand-rolled .ics files usually go wrong: an
 * inline VTIMEZONE with stale DST rules silently moves the meeting.
 */
export declare function icsCreate(i: IcsInput): string;
export declare function icsCreateDetailed(i: IcsInput): IcsResult;
