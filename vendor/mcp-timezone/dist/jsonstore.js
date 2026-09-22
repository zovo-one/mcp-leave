import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function blocked(file, moved) {
    return new CorruptDataError(`data file is corrupt; moved to ${moved}; nothing was written. ` +
        `Restore a good copy to ${file}, then delete ${markerPath(file)} to continue.`);
}
/**
 * D-R23: the marker is read by a model as often as by a human, so its contents are a
 * one-line JSON object that explains itself rather than a bare path. Older markers hold
 * just the quarantine path, so reading falls back to the raw text.
 */
export function markerBody(quarantined) {
    return JSON.stringify({
        quarantined,
        at: new Date().toISOString(),
        hint: "the original data file failed to parse; it was moved, nothing was overwritten; restore it manually or delete this marker to start fresh",
    }) + "\n";
}
function markerQuarantinePath(raw) {
    const t = raw.trim();
    if (!t)
        return undefined;
    try {
        const parsed = JSON.parse(t);
        if (typeof parsed.quarantined === "string" && parsed.quarantined)
            return parsed.quarantined;
        return undefined;
    }
    catch {
        return t;
    } // pre-D-R23 marker: the file held the path alone
}
export function readJsonFile(file, empty) {
    const marker = markerPath(file);
    if (existsSync(marker)) {
        let moved = `${file}.corrupt-*`;
        try {
            moved = markerQuarantinePath(readFileSync(marker, "utf8")) ?? moved;
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
        const moved = `${file}.corrupt-${stamp()}`;
        try {
            renameSync(file, moved);
            writeFileSync(marker, markerBody(moved));
        }
        catch { /* keep the parse error */ }
        process.stderr.write(`timezone: ${file} is not valid JSON (${e.message}); moved to ${moved}\n`);
        throw blocked(file, moved);
    }
}
