/** A lock older than this is treated as abandoned by a crashed process. */
export declare const STALE_MS = 30000;
/**
 * Run `fn` while holding an advisory cross-process lock.
 *
 * The lock is a directory: `mkdir` is atomic on every POSIX and Windows filesystem,
 * so EEXIST means another process holds it. Waiters retry with 5-25 ms jittered
 * sleeps until `timeoutMs` (default 5000). A lock directory whose mtime is older
 * than 30 s is assumed to belong to a process that died and is removed.
 *
 * Pure node, no dependencies. The lock is always released in `finally`.
 */
export declare function withFileLock<T>(lockPath: string, fn: () => Promise<T> | T, opts?: {
    timeoutMs?: number;
}): Promise<T>;
