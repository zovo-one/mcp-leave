import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
/** A lock older than this is treated as abandoned by a crashed process. */
export const STALE_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function tryAcquire(lockPath) {
    try {
        mkdirSync(lockPath);
        return true;
    }
    catch (e) {
        if (e && e.code === "EEXIST")
            return false;
        if (e && e.code === "ENOENT") {
            // Parent data dir does not exist yet.
            mkdirSync(dirname(lockPath), { recursive: true });
            try {
                mkdirSync(lockPath);
                return true;
            }
            catch {
                return false;
            }
        }
        throw e;
    }
}
/** Remove a lock dir whose mtime is older than STALE_MS. Returns true if it removed one. */
function reapStale(lockPath) {
    try {
        const st = statSync(lockPath);
        if (Date.now() - st.mtimeMs > STALE_MS) {
            rmdirSync(lockPath);
            return true;
        }
    }
    catch { /* gone already, or not a dir */ }
    return false;
}
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
export async function withFileLock(lockPath, fn, opts) {
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const deadline = Date.now() + timeoutMs;
    let held = false;
    for (;;) {
        if (tryAcquire(lockPath)) {
            held = true;
            break;
        }
        if (reapStale(lockPath) && tryAcquire(lockPath)) {
            held = true;
            break;
        }
        if (Date.now() >= deadline) {
            throw new Error(`timed out after ${timeoutMs} ms waiting for lock ${lockPath}`);
        }
        await sleep(5 + Math.random() * 20);
    }
    try {
        return await fn();
    }
    finally {
        if (held) {
            try {
                rmdirSync(lockPath);
            }
            catch { /* already released */ }
        }
    }
}
