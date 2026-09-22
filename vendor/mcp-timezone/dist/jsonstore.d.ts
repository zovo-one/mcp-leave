/**
 * Codex v3 #1 (P0). A read or JSON.parse failure must never be reported as "empty
 * database": the next mutation would then overwrite a history that is still on disk.
 * Only ENOENT means empty. A parse failure quarantines the file byte-for-byte as
 * <file>.corrupt-<timestamp>, writes a marker so every later call (read or write)
 * keeps failing until a human resolves it, and throws.
 */
export declare class CorruptDataError extends Error {
}
export declare function markerPath(file: string): string;
/**
 * D-R23: the marker is read by a model as often as by a human, so its contents are a
 * one-line JSON object that explains itself rather than a bare path. Older markers hold
 * just the quarantine path, so reading falls back to the raw text.
 */
export declare function markerBody(quarantined: string): string;
export declare function readJsonFile<T>(file: string, empty: T): T;
