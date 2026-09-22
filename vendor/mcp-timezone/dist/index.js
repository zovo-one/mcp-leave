#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, isAbsolute, resolve as pathResolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createLicenseGate, EMAIL_PLACEHOLDER, readSharedProfile, withFileLock } from "@theluckystrike/mcp-license";
import { readJsonFile } from "./jsonstore.js";
import { DROPPED_PLACES, PLACE_COUNT, UnknownZoneError, businessDays, dateKey, describe, dstChanges, findNearMissSlots, findSlots, hhmmToMinutes, icsCreateDetailed, offsetLabel, offsetMinutes, overlapOnLocalDate, parseIsoDateStrict, parseTimeIn, parseTimeInDetailed, resolveZone, timeKey, wallIn, weekdayIn, zoneAbbrev, zonedToUtc, } from "./tz.js";
import { VERSION } from "./version.js";
const PRODUCT = "timezone";
const FREE_MAX_PARTICIPANTS = 3;
const FREE_MAX_DAYS = 5;
const FREE_MAX_CONTACTS = 5;
const FREE_ICS_PER_MONTH = 3;
/**
 * Caller-supplied text is bounded at the schema. Without this a 1 MB zone name comes
 * back inside a 1 MB error message, and a 1 MB event title writes a 1 MB .ics file.
 * The numeric caps bound the work a single call can ask for: findSlots is
 * O(days x participants x 52), so an unbounded `days` under Pro is a free hang.
 */
const MAX_ZONE_TEXT = 100;
const MAX_TITLE = 200;
const MAX_BODY = 5000;
const MAX_PATH = 4096;
const MAX_ZONES = 50;
const MAX_PARTICIPANTS = 100;
const MAX_DAYS = 366;
const MAX_DURATION = 1440;
const MAX_HOLIDAYS = 400;
const text = (max, what) => z.string().max(max, `${what} must be ${max} characters or fewer`);
const gate = createLicenseGate({ product: PRODUCT });
const EMPTY = { version: 1, contacts: {}, ics: {} };
function dataDir() {
    const base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    return join(base, "mcp-servers", PRODUCT);
}
function dbPath() { return join(dataDir(), "data.json"); }
const LOCK = join(dataDir(), ".lock");
/** Only a missing file is an empty database (jsonstore quarantines a corrupt one). */
function load() {
    const raw = readJsonFile(dbPath(), { ...EMPTY });
    return {
        version: 1,
        contacts: raw.contacts && typeof raw.contacts === "object" ? raw.contacts : {},
        ics: raw.ics && typeof raw.ics === "object" ? raw.ics : {},
    };
}
function save(db) {
    const dir = dataDir();
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const p = dbPath();
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, p);
}
/* ------------------------------------------------------------- primitives */
const ok = (text) => ({ content: [{ type: "text", text }] });
const err = (text) => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
/** A gated feature is not an error: the user must see the upgrade path. */
const gated = (feature, toolName) => ok(gate.upgradeText(feature, toolName));
function guard(fn) {
    return async (a) => {
        try {
            return await fn(a);
        }
        catch (e) {
            return err(e instanceof Error ? e.message : String(e));
        }
    };
}
/**
 * A resolution can carry a note the caller has to see - "EST is a fixed offset, not
 * New York". Notes are collected per call and appended once, deduplicated.
 */
const HOME_WORDS = new Set(["home", "me", "my zone", "my timezone", "my time zone", "local", "my local time"]);
/**
 * D-R31/D-R35: "home" is whatever timezone the shared business profile carries, so the zone
 * the user declared once at onboarding is the zone every later question defaults to.
 */
function homeZone() {
    const tz = readSharedProfile().timezone;
    if (!tz)
        return undefined;
    try {
        new Intl.DateTimeFormat("en-CA", { timeZone: tz });
        return tz;
    }
    catch {
        return undefined;
    }
}
function zoneOf(input, notes) {
    const word = String(input ?? "").trim().toLowerCase();
    if (HOME_WORDS.has(word)) {
        const home = homeZone();
        if (home) {
            const n = `"${input}" resolved to ${home}, the timezone on your shared business profile.`;
            if (notes && !notes.includes(n))
                notes.push(n);
            return home;
        }
        const n = `No home timezone is stored: set one with business_set {timezone: "Europe/Warsaw"} in the invoice or docx server, and "home" will resolve to it everywhere.`;
        if (notes && !notes.includes(n))
            notes.push(n);
    }
    const hit = resolveZone(input);
    if (hit.note && notes && !notes.includes(hit.note))
        notes.push(hit.note);
    return hit.zone;
}
const withNotes = (body, notes) => notes.length ? `${body}\n\nNote: ${notes.join("\nNote: ")}` : body;
/** The DST policy arguments shared by the tools that read a wall-clock time. */
const gapArg = z.enum(["forward", "backward"]).optional()
    .describe("What to do with a time that does not exist because the clocks jumped forward: 'forward' takes the time after the jump, 'backward' the time before it. Without this, such a time is refused.");
const foldArg = z.enum(["first", "second"]).optional()
    .describe("Which occurrence of a time that happens twice because the clocks went back. Default 'first'.");
const policyOf = (a) => ({ gap: a.gap, fold: a.fold });
function monthKey(d = new Date()) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function outPathOf(p) {
    const abs = isAbsolute(p) ? p : pathResolve(process.cwd(), p);
    const dir = dirname(abs);
    // mkdirSync(recursive) never returns on a pseudo-filesystem. Measured on Linux in a
    // node:22-alpine container: mkdir("/proc/nope") answers ENOENT in 0 ms, Node reads that
    // as a missing parent and retries forever, and the call had not returned after 25
    // seconds. Any caller-supplied out_path under /proc, /sys or /dev hung the server
    // permanently. The ancestors are walked here instead, under a hard bound, and each
    // level is created non-recursively so a repeated ENOENT terminates on the first one.
    if (!existsSync(dir)) {
        const missing = [];
        let cur = dir;
        for (let i = 0; i < 64 && !existsSync(cur); i++) {
            missing.push(cur);
            const parent = dirname(cur);
            if (parent === cur)
                break;
            cur = parent;
        }
        if (!existsSync(cur))
            throw new Error(`cannot create ${dir}: no existing ancestor directory`);
        for (const d of missing.reverse())
            mkdirSync(d);
    }
    return abs;
}
/* ---------------------------------------------------------------- server */
const server = new McpServer({ name: "mcp-timezone", version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });
gate.registerTools(server);
/* ------------------------------------------------------------------- now */
server.registerTool("now", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Current time in zones",
    description: "The current time in one or more places, each with the zone it resolved to and the local date, time and offset, under one UTC instant. Accepts IANA zones, cities, countries and abbreviations.",
    inputSchema: {
        zones: z.array(text(MAX_ZONE_TEXT, "a zone")).max(MAX_ZONES).optional().describe("Places or IANA zones, e.g. ['Warsaw','New York','India']"),
    },
}, guard(async ({ zones }) => {
    const list = zones && zones.length
        ? zones
        : [Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC"];
    const at = new Date();
    const notes = [];
    const rows = list.map(input => {
        const zone = zoneOf(input, notes);
        return `${input} -> ${zone}: ${describe(at, zone)}`;
    });
    return ok(withNotes(`Now (${at.toISOString()} UTC)\n${rows.join("\n")}`, notes));
}));
/* ---------------------------------------------------------- convert_time */
server.registerTool("convert_time", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Convert a time between zones",
    description: "Convert one time from from_zone into every zone in to_zones, marking any day change, plus the UTC instant. The time is wall-clock in from_zone unless it carries an offset or a trailing Z. '3pm tomorrow' works.",
    inputSchema: {
        time: text(MAX_ZONE_TEXT, "time").describe("'2026-09-10 15:00', '2026-09-10T15:00:00Z', '3pm tomorrow', 'now'"),
        from_zone: text(MAX_ZONE_TEXT, "from_zone").describe("Place the time is given in, e.g. 'Warsaw' or 'Europe/Warsaw'"),
        to_zones: z.array(text(MAX_ZONE_TEXT, "a zone")).min(1).max(MAX_ZONES).describe("Places to convert into"),
        gap: gapArg,
        fold: foldArg,
    },
}, guard(async (a) => {
    const { time, from_zone, to_zones } = a;
    const notes = [];
    const from = zoneOf(from_zone, notes);
    const parsed = parseTimeInDetailed(time, from, new Date(), policyOf(a));
    const at = parsed.date;
    if (parsed.resolution?.note)
        notes.push(parsed.resolution.note);
    const lines = [`${from_zone} -> ${from}: ${describe(at, from)}`];
    for (const t of to_zones) {
        const z = zoneOf(t, notes);
        const dayDelta = Number(dateKey(wallIn(at, z)).replace(/-/g, "")) - Number(dateKey(wallIn(at, from)).replace(/-/g, ""));
        const note = dayDelta === 0 ? "" : dayDelta > 0 ? "  (next day)" : "  (previous day)";
        lines.push(`${t} -> ${z}: ${describe(at, z)}${note}`);
    }
    lines.push(`UTC instant: ${at.toISOString()}`);
    return ok(withNotes(lines.join("\n"), notes));
}));
/* --------------------------------------------------------------- overlap */
function windowsFor(zones, ws, we, notes) {
    const startMin = hhmmToMinutes(ws, "work_start");
    const endMin = hhmmToMinutes(we, "work_end");
    if (endMin <= startMin)
        throw new Error(`work_end (${we}) must be after work_start (${ws})`);
    return zones.map(z => ({ zone: zoneOf(z, notes), label: z, startMin, endMin }));
}
server.registerTool("overlap", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Daily working-hours overlap",
    description: "The window each day when every listed place is inside working hours. Computed on a real date, so a DST week that widens or narrows the overlap is reflected.",
    inputSchema: {
        zones: z.array(text(MAX_ZONE_TEXT, "a zone")).min(2).max(MAX_ZONES).describe("Places, e.g. ['Warsaw','New York','Bangalore']"),
        work_start: text(16, "work_start").optional().describe("Local working day start, default 09:00"),
        work_end: text(16, "work_end").optional().describe("Local working day end, default 17:00"),
        date: text(MAX_ZONE_TEXT, "date").optional().describe("Date to compute on, YYYY-MM-DD, default today"),
    },
}, guard(async ({ zones, work_start = "09:00", work_end = "17:00", date }) => {
    const notes = [];
    const ws = windowsFor(zones, work_start, work_end, notes);
    // V4-7: the day is a LOCAL calendar date, and every boundary is built from that date
    // in its own zone. Reading it as "the UTC day containing local midnight" reported the
    // previous day for every zone east of Greenwich.
    const anchor = ws[0].zone;
    const dayKey = date
        ? (/^\d{4}-\d{2}-\d{2}$/.test(date.trim())
            ? dateKey(parseIsoDateStrict(date, "date"))
            : dateKey(wallIn(parseTimeIn(date, anchor), anchor)))
        : dateKey(wallIn(new Date(), anchor));
    const o = overlapOnLocalDate(ws, dayKey);
    const head = `Working hours ${work_start}-${work_end} local, on ${dayKey} (local date in every zone listed)`;
    if (!o) {
        const [yy, mm, dd] = dayKey.split("-").map(Number);
        const noon = zonedToUtc({ y: yy, m: mm, d: dd, h: 12, mi: 0, s: 0 }, anchor, { gap: "forward" });
        const offs = ws.map(w => `  ${w.label} (${w.zone}): ${offsetLabel(offsetMinutes(noon, w.zone))}`).join("\n");
        return ok(withNotes(`${head}\nNo overlap: the working days do not intersect.\n${offs}\nWiden work_start/work_end, or plan an asynchronous handoff.`, notes));
    }
    const { startUtc, endUtc } = o;
    const rows = ws.map(w => `  ${w.label} (${w.zone}): ${dateKey(wallIn(startUtc, w.zone))} ${timeKey(wallIn(startUtc, w.zone))} - ${timeKey(wallIn(endUtc, w.zone))} ${zoneAbbrev(startUtc, w.zone)}`);
    const mins = Math.round((endUtc.getTime() - startUtc.getTime()) / 60000);
    return ok(withNotes(`${head}\nOverlap: ${Math.floor(mins / 60)}h ${mins % 60}m\n` +
        `  UTC: ${startUtc.toISOString()} - ${endUtc.toISOString()}\n${rows.join("\n")}`, notes));
}));
/* ----------------------------------------------------- find_meeting_slots */
const participantSchema = z.object({
    name: text(MAX_ZONE_TEXT, "name").min(1).describe("Person or client name. A name you already saved with contacts_set needs nothing else: their zone and working hours are read from the contact"),
    zone: text(MAX_ZONE_TEXT, "zone").optional().describe("Their place or IANA zone. Optional: leave it out for a saved contact, and leave it out for YOURSELF - your own zone comes from your shared business profile, so you never have to be asked for it"),
    work_start: text(16, "work_start").optional().describe("Their local day start, default 09:00 or the saved contact's"),
    work_end: text(16, "work_end").optional().describe("Their local day end, default 17:00 or the saved contact's"),
});
/**
 * D-R82, the D-R64 species in a third server. "Find a slot that works for all three of us"
 * used to be unanswerable: every participant needed an explicit `zone`, nothing surfaced the
 * caller's own, and the model did the only thing left and asked the user what timezone they
 * are in - a fact the shared business profile has carried since D-R31, and that this same
 * file already reads for `now` and for the ICS organizer. Measured hosted in round 15: the
 * turn produced no tool call at all. A zone is now optional and resolved from, in order, a
 * saved contact of that name, then the shared business profile. Where each one came from is
 * reported, because a slot computed against a guessed zone is worse than a question.
 */
function resolveParticipantZone(p, contacts) {
    if (p.zone)
        return { zone: zoneOf(p.zone), source: "the zone you passed" };
    const saved = Object.values(contacts).find(c => c.name.trim().toLowerCase() === p.name.trim().toLowerCase());
    if (saved)
        return { zone: saved.zone, source: `your saved contact "${saved.name}"`, contact: saved };
    const home = readSharedProfile().timezone;
    if (home)
        return { zone: zoneOf(home), source: "your shared business profile (set with business_set on any endpoint)" };
    throw new Error(`${p.name} has no timezone. Pass zone for them, or save them once with contacts_set {name, zone}. ` +
        `If ${p.name} is you, set your own timezone once with business_set {timezone: "Europe/Warsaw"} on any endpoint ` +
        `and every server behind this token reads it - you should not have to be asked for it again.`);
}
function toParticipants(list) {
    const contacts = load().contacts;
    const sources = [];
    const parts = list.map(p => {
        const r = resolveParticipantZone(p, contacts);
        if (!p.zone)
            sources.push(`${p.name}: ${r.zone}, from ${r.source}`);
        const startMin = hhmmToMinutes(p.work_start ?? r.contact?.workStart ?? "09:00", `${p.name} work_start`);
        const endMin = hhmmToMinutes(p.work_end ?? r.contact?.workEnd ?? "17:00", `${p.name} work_end`);
        if (endMin <= startMin)
            throw new Error(`${p.name}: work_end must be after work_start`);
        return { name: p.name, zone: r.zone, startMin, endMin };
    });
    return { parts, sources };
}
server.registerTool("find_meeting_slots", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Find meeting slots",
    description: "Rank the times when every participant is inside their own working hours. Returns each slot as a UTC instant with the local time for every participant and a fairness score, best first.",
    inputSchema: {
        participants: z.array(participantSchema).min(1).max(MAX_PARTICIPANTS).describe("Who has to attend. A zone is OPTIONAL per person: a saved contact supplies their own, and anyone left without one (you, typically) takes the timezone on your shared business profile, so never ask the caller what timezone they are in - include yourself by name and let the server resolve it. Every slot returned is inside all of their hours; weekends in the first participant's zone are skipped. Free tier: up to 3 participants"),
        duration_minutes: z.number().int().positive().max(MAX_DURATION).optional().describe("Meeting length in minutes, default 60, at most 1440"),
        days: z.number().int().positive().max(MAX_DAYS).optional().describe("How many days ahead to search, default 5, at most 366. Free tier: a search longer than 5 days is shortened to 5, not refused"),
        earliest_date: text(MAX_ZONE_TEXT, "earliest_date").optional().describe("First date to consider, YYYY-MM-DD, default today"),
        limit: z.number().int().positive().max(100).optional().describe("How many slots to return, default 8. Slots are ranked by fairness: the score is the WORST participant's distance in hours from 13:00 local, so a slot that is 07:00 for one person never outranks one that suits everybody"),
        recurring: z.boolean().optional().describe("Pro: also report the weekly recurring times that work on every searched weekday"),
    },
}, guard(async (a) => {
    const pro = gate.isPro();
    const duration = a.duration_minutes ?? 60;
    const asked = a.days ?? 5;
    if (!pro && a.participants.length > FREE_MAX_PARTICIPANTS) {
        return gated(`a meeting with ${a.participants.length} participants (the free tier plans up to ${FREE_MAX_PARTICIPANTS})`, "find_meeting_slots");
    }
    // D-R30: a search longer than the free cap is SHORTENED, not refused. Returning only an
    // upgrade wall to a question that has a usable answer inside the free window is worse
    // for the user than answering and naming the cap.
    const days = !pro && asked > FREE_MAX_DAYS ? FREE_MAX_DAYS : asked;
    const capped = days !== asked
        ? `\n\nSearched ${days} of the ${asked} days you asked for: the free tier searches up to ${FREE_MAX_DAYS} days ahead. ${gate.upgradeText(`a ${asked}-day search`, "find_meeting_slots")}`
        : "";
    if (!pro && a.recurring)
        return gated("recurring-slot search", "find_meeting_slots");
    const resolved = toParticipants(a.participants);
    const parts = resolved.parts;
    const zoneSources = resolved.sources.length
        ? `\n\nZones you did not pass, and where each came from:\n${resolved.sources.map(r => `  ${r}`).join("\n")}`
        : "";
    const first = a.earliest_date ? parseTimeIn(a.earliest_date, parts[0].zone) : new Date();
    const all = findSlots(parts, duration, days, first);
    // D-R84: `days` counts calendar days forward from `earliest_date` (or now) regardless
    // of week boundaries, so "this week" asked for on a Friday or Saturday can quietly
    // become next week. searched_from/searched_to are reported every time, and when the
    // window runs past the anchor zone's Sunday, that is said in one sentence rather than
    // left for the caller to notice from the dates in the slot list.
    const anchorZone = parts[0].zone;
    const w0 = wallIn(first, anchorZone);
    const lastDay = new Date(Date.UTC(w0.y, w0.m - 1, w0.d + (days - 1), 12));
    const wLast = { y: lastDay.getUTCFullYear(), m: lastDay.getUTCMonth() + 1, d: lastDay.getUTCDate(), h: 0, mi: 0, s: 0 };
    const searchedFrom = dateKey(w0);
    const searchedTo = dateKey(wLast);
    const startDow = new Date(Date.UTC(w0.y, w0.m - 1, w0.d)).getUTCDay(); // 0=Sun..6=Sat
    const daysToSunday = startDow === 0 ? 0 : 7 - startDow; // days from start to that week's Sunday
    const rolledToNextWeek = (days - 1) > daysToSunday;
    const weekNote = rolledToNextWeek
        ? `\n\nThis search runs from ${searchedFrom} (${weekdayIn(first, anchorZone)}) through ${searchedTo} ` +
            `(${weekdayIn(lastDay, anchorZone)}) in ${anchorZone} local, which is past this calendar week's end - ` +
            `"this week" asked for ${daysToSunday <= 0 ? "today" : `${daysToSunday} day(s) left`} may have already run out.`
        : "";
    const windowLine = `\n\nSearched ${searchedFrom} to ${searchedTo} (${days} calendar day(s) forward from ` +
        `${a.earliest_date ? `earliest_date ${a.earliest_date}` : "today"}, ${anchorZone} local; weekends skipped).`;
    if (!all.length) {
        const rows = parts.map(p => `  ${p.name} (${p.zone}): ${timeKey({ y: 0, m: 0, d: 0, h: Math.floor(p.startMin / 60), mi: p.startMin % 60, s: 0 })} - ${timeKey({ y: 0, m: 0, d: 0, h: Math.floor(p.endMin / 60), mi: p.endMin % 60, s: 0 })}`).join("\n");
        const near = findNearMissSlots(parts, duration, days, first, 30, 3);
        const nearText = near.length
            ? `\n\nClosest times, all OUTSIDE someone's hours (fewest minutes outside first):\n` +
                near.map((n, i) => {
                    const per = n.local.map(l => `${l.name} ${l.start}-${l.end} ${l.date}${l.outsideMinutes ? ` (${l.outsideMinutes} min outside; needs ${l.needStart}-${l.needEnd})` : " (inside hours)"}`).join(" | ");
                    return `${i + 1}. ${n.startUtc.toISOString()} UTC  ${n.outsideMinutes} min outside hours in total\n   ${per}`;
                }).join("\n") +
                `\n\nTo make the first one fit, set: ` +
                near[0].local.filter(l => l.outsideMinutes > 0).map(l => `${l.name} ${l.needStart}-${l.needEnd}`).join(", ") + "."
            : "";
        return ok(`No slot fits everyone's working hours in the next ${days} day(s) for ${duration} minutes.\n${rows}` +
            nearText +
            `\n\nTry a shorter duration, widen someone's work_start/work_end, or use overlap to see how far apart the days are.` +
            zoneSources + capped + windowLine + weekNote);
    }
    const limit = Math.max(1, Math.min(a.limit ?? 8, pro ? 50 : 10));
    const lines = all.slice(0, limit).map((s, i) => {
        const per = s.local.map(l => `${l.name} ${l.start}-${l.end} ${l.date}`).join(" | ");
        return `${i + 1}. ${s.startUtc.toISOString()} UTC  fairness ${s.fairness.toFixed(2)}h\n   ${per}`;
    });
    let extra = "";
    if (a.recurring && pro) {
        const byClock = new Map();
        for (const s of all) {
            const k = timeKey(wallIn(s.startUtc, parts[0].zone));
            byClock.set(k, (byClock.get(k) ?? 0) + 1);
        }
        const daysSearched = new Set(all.map(s => dateKey(wallIn(s.startUtc, parts[0].zone)))).size;
        const every = [...byClock.entries()].filter(([, n]) => n >= daysSearched).map(([k]) => k).sort();
        extra = `\n\nRecurring (works on all ${daysSearched} searched weekdays, ${parts[0].zone} local): ` +
            (every.length ? every.join(", ") : "none");
    }
    const note = pro ? "" : (capped || `\n\n${gate.upgradeText("more participants, longer searches and recurring slots", "find_meeting_slots")}`);
    return ok(`${all.length} slot(s) fit all ${parts.length} participants (${duration} min, ${days} day(s)). ` +
        `Best first, ranked by fairness: the score is the worst participant's distance in hours from 13:00 local, ` +
        `so a slot that suits everybody outranks one that is 07:00 for someone. Weekends in ${parts[0].zone} are skipped.\n` +
        lines.join("\n") + zoneSources + extra + note + windowLine + weekNote);
}));
/* ----------------------------------------------------------- dst_changes */
server.registerTool("dst_changes", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Daylight-saving changes",
    description: "The clock changes in a place for a year, with the exact UTC instant and the offset before and after. Use it to check whether a recurring call moves for one of you in March or October.",
    inputSchema: {
        zone: text(MAX_ZONE_TEXT, "zone").describe("Place or IANA zone"),
        year: z.number().int().min(1850).max(2200).optional().describe("Calendar year, default this year"),
    },
}, guard(async ({ zone, year }) => {
    const z = zoneOf(zone);
    const y = year ?? new Date().getUTCFullYear();
    const changes = dstChanges(z, y);
    if (!changes.length)
        return ok(`${zone} -> ${z}: no clock changes in ${y}; the offset stays ${offsetLabel(offsetMinutes(new Date(Date.UTC(y, 5, 1)), z))} all year.`);
    const rows = changes.map(c => {
        const localBefore = describe(new Date(c.atUtc.getTime() - 60000), z);
        const localAfter = describe(c.atUtc, z);
        const delta = c.toOffset - c.fromOffset;
        return `  ${c.atUtc.toISOString()} UTC: ${offsetLabel(c.fromOffset)} -> ${offsetLabel(c.toOffset)} (${delta > 0 ? "+" : ""}${delta} min)\n` +
            `    local ${localBefore} becomes ${localAfter}`;
    });
    return ok(`${zone} -> ${z}, clock changes in ${y}:\n${rows.join("\n")}`);
}));
/* --------------------------------------------------------- business_days */
server.registerTool("business_days", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Count business days",
    description: "Count business days between two dates in a place, inclusive, with the calendar total and the weekend and holiday counts. It has NO holiday calendar: without holidays, only weekends are excluded.",
    inputSchema: {
        from: text(MAX_ZONE_TEXT, "from").describe("Start date, YYYY-MM-DD (inclusive). A date that does not exist, such as 2026-02-30, is refused, never rolled forward"),
        to: text(MAX_ZONE_TEXT, "to").describe("End date, YYYY-MM-DD (inclusive)"),
        zone: text(MAX_ZONE_TEXT, "zone").describe("Place whose calendar to use"),
        holidays: z.array(text(32, "a holiday")).max(MAX_HOLIDAYS).optional().describe("Dates to exclude, strict YYYY-MM-DD. This tool has no national holiday calendar: unless you pass holidays here only weekends are excluded, so do not report the answer as a public-holiday-adjusted count"),
    },
}, guard(async ({ from, to, zone, holidays }) => {
    const z = zoneOf(zone);
    const r = businessDays(from, to, z, holidays ?? []);
    const listed = r.days.length <= 20 ? `\nDays: ${r.days.join(", ")}` : "";
    // D-T1: the count is only as good as the holiday list it was given. Say so, or a model
    // narrates "no public holidays that month" as though the tool had checked a calendar.
    const hol = holidays && holidays.length
        ? `\nExcluded as holidays: ${holidays.join(", ")} (${r.holidayCount} of them fell on a weekday).`
        : `\nNo holidays were passed, so only weekends were excluded; this tool has no national ` +
            `holiday calendar - pass holidays to exclude them.`;
    return ok(`${from} to ${to} in ${z}: ${r.days.length} business day(s) of ${r.total} calendar day(s) ` +
        `(${r.weekendCount} weekend, ${r.holidayCount} holiday).${hol}${listed}`);
}));
/* -------------------------------------------------------------- contacts */
server.registerTool("contacts_set", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Save a contact's zone",
    description: "Save one person's zone and working hours so later calls can name them. Returns the resolved zone and their local time now. Saving the same name REPLACES that contact and says so. Free: 5 contacts.",
    inputSchema: {
        name: text(MAX_ZONE_TEXT, "name").min(1).describe("Their name"),
        zone: text(MAX_ZONE_TEXT, "zone").min(1).describe("Their place or IANA zone"),
        work_start: text(16, "work_start").optional().describe("Local day start, default 09:00"),
        work_end: text(16, "work_end").optional().describe("Local day end, default 17:00"),
    },
}, guard(async ({ name, zone, work_start = "09:00", work_end = "17:00" }) => {
    const z = zoneOf(zone); // a fixed abbreviation resolves to a fixed offset; see resolveZone
    hhmmToMinutes(work_start, "work_start");
    hhmmToMinutes(work_end, "work_end");
    return withFileLock(LOCK, async () => {
        const db = load();
        const key = name.trim().toLowerCase();
        const prev = db.contacts[key];
        const isNew = !prev;
        if (isNew && !gate.isPro() && Object.keys(db.contacts).length >= FREE_MAX_CONTACTS) {
            return gated(`a ${FREE_MAX_CONTACTS + 1}th saved contact (the free tier keeps ${FREE_MAX_CONTACTS})`, "contacts_set");
        }
        db.contacts[key] = { name: name.trim(), zone: z, workStart: work_start, workEnd: work_end, updated: new Date().toISOString() };
        save(db);
        // A second "Sara" is the same key. Saying so out loud is the difference between
        // updating a contact and silently moving an existing person to another continent.
        const replaced = prev && (prev.zone !== z || prev.workStart !== work_start || prev.workEnd !== work_end)
            ? ` Replaced the saved ${prev.name} (was ${prev.zone}, ${prev.workStart}-${prev.workEnd}); names are matched case-insensitively.`
            : "";
        return ok(`Saved ${name.trim()}: ${z}, ${work_start}-${work_end} local. Local time there now: ${describe(new Date(), z)}.${replaced}`);
    });
}));
server.registerTool("contacts_list", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    title: "List saved contacts",
    description: "List saved contacts with their zone, local time now, working hours and whether they are inside them; weekends count as outside. It also prints YOUR zone from the shared business profile.",
    inputSchema: {},
}, guard(async () => {
    const db = load();
    // D-R82. A contact list that holds everyone EXCEPT the caller is why a model asked the
    // user what timezone they are in. The home zone is on the shared business profile and
    // this file already reads it; it just never showed it to anyone.
    const home = readSharedProfile().timezone;
    const youLine = home
        ? `  You: ${zoneOf(home)}, ${describe(new Date(), zoneOf(home))} - from your shared business profile, so you never need to pass your own zone to find_meeting_slots`
        : `  You: no timezone yet. Set it once with business_set {timezone: "Europe/Warsaw"} on any endpoint and every server behind this token reads it.`;
    const cs = Object.values(db.contacts).sort((a, b) => a.name.localeCompare(b.name));
    if (!cs.length)
        return ok(`No contacts saved yet. Use contacts_set with a name and a place.\n\n${youLine}`);
    const at = new Date();
    const rows = cs.map(c => {
        const w = wallIn(at, c.zone);
        const nowMin = w.h * 60 + w.mi;
        const inHours = nowMin >= hhmmToMinutes(c.workStart) && nowMin < hhmmToMinutes(c.workEnd)
            && weekdayIn(at, c.zone) !== "Sat" && weekdayIn(at, c.zone) !== "Sun";
        return `  ${c.name}: ${c.zone}, ${describe(at, c.zone)}, works ${c.workStart}-${c.workEnd} - ${inHours ? "available now" : "outside working hours"}`;
    });
    return ok(`${cs.length} contact(s):\n${rows.join("\n")}\n${youLine}`);
}));
/* ------------------------------------------------------------- ics_create */
server.registerTool("ics_create", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    title: "Write a calendar invite",
    description: "Call this tool to write a .ics for one meeting and return the path plus the start in UTC and in your zone. Times are stored in UTC so it lands correctly in any client. Free: 3 files a month.",
    inputSchema: {
        title: text(MAX_TITLE, "title").min(1).describe("Event title"),
        start: text(MAX_ZONE_TEXT, "start").describe("Start time, read in `zone` unless it carries an offset"),
        zone: text(MAX_ZONE_TEXT, "zone").describe("Place the start time is given in"),
        duration_minutes: z.number().int().positive().max(MAX_DURATION).describe("Length in minutes, at most 1440"),
        attendees: z.array(z.union([
            text(MAX_TITLE, "an attendee"),
            z.object({
                name: text(MAX_TITLE, "an attendee name").optional().describe("Display name"),
                email: text(MAX_TITLE, "an attendee email").optional().describe("Their email address"),
            }),
        ])).max(MAX_PARTICIPANTS).optional().describe("Attendees. An entry with an email is invited (ATTENDEE:mailto:...); a name with no email is listed in the description instead, because a calendar cannot invite a name."),
        organizer_email: text(MAX_TITLE, "organizer_email").optional().describe("Your email address, written as the ORGANIZER so replies have somewhere to go. Leave it out and your shared business profile's email is used; with neither, the ORGANIZER line is omitted rather than filled with an address you improvised"),
        organizer_name: text(MAX_TITLE, "organizer_name").optional().describe("Your display name for the ORGANIZER line"),
        description: text(MAX_BODY, "description").optional().describe("Body text"),
        location: text(MAX_TITLE, "location").optional().describe("Where, or a meeting link"),
        out_path: text(MAX_PATH, "out_path").optional().describe("Where to write the .ics file; default meeting.ics in the data dir. Times are stored in UTC, so the invite lands at the right local time in every attendee's calendar with no time zone block to go stale"),
        gap: gapArg,
        fold: foldArg,
    },
}, guard(async (a) => {
    const notes = [];
    const z = zoneOf(a.zone, notes);
    const parsed = parseTimeInDetailed(a.start, z, new Date(), policyOf(a));
    const startUtc = parsed.date;
    if (parsed.resolution?.note)
        notes.push(parsed.resolution.note);
    return withFileLock(LOCK, async () => {
        const db = load();
        const mk = monthKey();
        const used = db.ics[mk] ?? 0;
        if (!gate.isPro() && used >= FREE_ICS_PER_MONTH) {
            return gated(`a ${FREE_ICS_PER_MONTH + 1}th calendar file this month (the free tier writes ${FREE_ICS_PER_MONTH})`, "ics_create");
        }
        const built = icsCreateDetailed({
            title: a.title, startUtc, durationMinutes: a.duration_minutes,
            attendees: a.attendees, description: a.description, location: a.location,
            // D-R40: an ORGANIZER address comes from this call or from the shared business
            // profile. In round 8 a model put the operator's own account address on a client's
            // calendar invite because nothing else was available.
            organizerEmail: a.organizer_email ?? readSharedProfile().email,
            organizerName: a.organizer_name ?? readSharedProfile().name,
        });
        const text = built.text;
        if (built.listedOnly.length) {
            notes.push(`${built.listedOnly.join(", ")} had no email address, so ${built.listedOnly.length === 1 ? "the name is" : "the names are"} listed in the description instead of being invited. Pass {name, email} to invite them.`);
        }
        if (!built.organizer) {
            notes.push(`No ORGANIZER line was written (${EMAIL_PLACEHOLDER}): pass organizer_email, or store it once with business_set {email} in the invoice or docx server so every invite carries it. Do not use an address the user has not given you.`);
        }
        const dir = dataDir();
        if (!existsSync(dir))
            mkdirSync(dir, { recursive: true });
        const path = outPathOf(a.out_path ?? join(dir, "meeting.ics"));
        writeFileSync(path, text, "utf8");
        db.ics[mk] = used + 1;
        save(db);
        const rest = gate.isPro() ? "" : ` (${FREE_ICS_PER_MONTH - used - 1} left this month on the free tier)`;
        return ok(withNotes(`Wrote ${path}${rest}\n${a.title}: ${describe(startUtc, z)} for ${a.duration_minutes} min\n` +
            `DTSTART ${startUtc.toISOString()} (UTC)`, notes));
    });
}));
/* -------------------------------------------------------- resource, prompt */
server.registerResource("contacts", "tz://contacts", {
    title: "Saved contacts and their local time",
    description: "Every saved contact with their zone, working hours and current local time.",
    mimeType: "text/plain",
}, async (uri) => {
    const db = load();
    const at = new Date();
    const cs = Object.values(db.contacts).sort((a, b) => a.name.localeCompare(b.name));
    const text = cs.length
        ? cs.map(c => `${c.name}\t${c.zone}\t${describe(at, c.zone)}\t${c.workStart}-${c.workEnd}`).join("\n")
        : "(no contacts saved)";
    return { contents: [{ uri: uri.href, mimeType: "text/plain", text }] };
});
server.registerPrompt("schedule_with", {
    title: "Schedule with saved contacts",
    description: "Propose meeting times with saved contacts, using their stored zones and working hours.",
    argsSchema: {
        names: z.string().describe("Comma-separated contact names, or 'all'"),
        duration_minutes: z.string().optional().describe("Meeting length in minutes, default 60"),
    },
}, ({ names, duration_minutes }) => {
    const db = load();
    const all = Object.values(db.contacts);
    const wanted = String(names).trim().toLowerCase() === "all"
        ? all
        : String(names).split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
            .map(n => db.contacts[n]).filter(Boolean);
    const missing = String(names).trim().toLowerCase() === "all"
        ? []
        : String(names).split(",").map(s => s.trim()).filter(s => s && !db.contacts[s.toLowerCase()]);
    const roster = wanted.length
        ? wanted.map(c => `- ${c.name}: zone ${c.zone}, works ${c.workStart}-${c.workEnd}`).join("\n")
        : "(no matching saved contacts)";
    const text = `Propose meeting times with these people. My own zone is ${Intl.DateTimeFormat().resolvedOptions().timeZone}.\n\n` +
        `PARTICIPANTS\n${roster}\n` +
        (missing.length ? `\nNOT SAVED (ask me for their zone): ${missing.join(", ")}\n` : "") +
        `\nCall find_meeting_slots with exactly these participants, duration_minutes ${duration_minutes ?? "60"}, ` +
        `and their stored work_start/work_end. Then give me the top three options as plain sentences with each ` +
        `person's local time, say which one is fairest and why, and offer to write the .ics for the one I pick.`;
    return { messages: [{ role: "user", content: { type: "text", text } }] };
});
/* ------------------------------------------------------------------ boot */
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    if (DROPPED_PLACES.length) {
        process.stderr.write(`mcp-timezone: dropped ${DROPPED_PLACES.length} place entries this Node build cannot resolve: ${DROPPED_PLACES.join(", ")}\n`);
    }
    process.stderr.write(`mcp-timezone ready (${gate.isPro() ? "pro" : "free"}), ${PLACE_COUNT} places, data in ${dataDir()}\n`);
}
main().catch(e => {
    process.stderr.write(`fatal: ${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
});
export { UnknownZoneError };
