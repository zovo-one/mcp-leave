import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJsonFile } from "@theluckystrike/mcp-timezone/lib";
import type { Employee, LeaveRequest } from "./leave.js";

/**
 * Leave records live in ONE JSON file. Resolution order:
 *
 *   1. When `XDG_DATA_HOME` is set (the test suites set it to a temp dir), the store is
 *      `${XDG_DATA_HOME}/mcp-servers/leave/store.json`.
 *   2. Otherwise the store is the single file `~/.mcp-leave/store.json`, exactly as the
 *      brief asks. Nothing else is written anywhere.
 *
 * The whole store (employees and requests) lives in `store.json`, plus `counter.json` for
 * the next ids. Reads go through the timezone engine's `readJsonFile`, so a store that is
 * not JSON is quarantined byte-for-byte with a `.corrupt-<timestamp>` marker, mirroring the
 * checklist and invoice siblings.
 */

export interface LeaveStore {
  employees: Employee[];
  requests: LeaveRequest[];
}

export function storeDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".mcp-leave");
  const dir = join(dataHome, "mcp-servers", "leave");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function storePath(): string { return join(storeDir(), "store.json"); }
export function lockPath(): string { return join(storeDir(), ".lock"); }

function read<T>(file: string, empty: T): T {
  return readJsonFile<T>(join(storeDir(), file), empty);
}

/** Atomic: per-process temp name, then rename over the target. */
function write(file: string, value: unknown): void {
  const p = join(storeDir(), file);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, p);
}

export function getEmployees(): Employee[] { return read<LeaveStore>("store.json", { employees: [], requests: [] }).employees; }
export function setEmployees(v: Employee[]): void {
  const store = read<LeaveStore>("store.json", { employees: [], requests: [] });
  write("store.json", { employees: v, requests: store.requests });
}
export function getRequests(): LeaveRequest[] { return read<LeaveStore>("store.json", { employees: [], requests: [] }).requests; }
export function setRequests(v: LeaveRequest[]): void {
  const store = read<LeaveStore>("store.json", { employees: [], requests: [] });
  write("store.json", { employees: store.employees, requests: v });
}

/**
 * Allocate the next id in a counter series. The counter is written BEFORE the record is
 * stored, so a crash burns a number rather than reusing one, and the ids already in the
 * store are scanned as well, so a restored or hand-edited store cannot reissue a number.
 */
export function nextId(key: string, pad: number, existing: string[]): string {
  const counters = read<Record<string, number>>("counter.json", {});
  let n = counters[key] ?? 0;
  const used = new Set(existing);
  do { n += 1; } while (used.has(`${key}-${String(n).padStart(pad, "0")}`));
  counters[key] = n;
  write("counter.json", counters);
  return `${key}-${String(n).padStart(pad, "0")}`;
}

export function nextEmployeeId(existing: string[]): string {
  return nextId("EMP", 4, existing);
}
export function nextRequestId(existing: string[]): string {
  return nextId("LV", 4, existing);
}

/** Resolve an employee by id (case-insensitive) then by exact name, then partial name. */
export function findEmployee(list: Employee[], ref: string): Employee {
  const needle = ref.trim().toLowerCase();
  const byId = list.find((e) => e.id.toLowerCase() === needle);
  if (byId) return byId;
  const pool = list.filter((e) => e.name.toLowerCase().includes(needle));
  if (pool.length > 1) {
    throw new Error(`"${ref}" matches more than one employee: ${pool.map((e) => `${e.id} (${e.name})`).join(", ")}. Pass the exact id.`);
  }
  if (pool.length === 0) {
    throw new Error(`no employee matches "${ref}". Ids look like EMP-0001. Run leave_employee_add first, then leave_list.`);
  }
  return pool[0];
}

/** Resolve a request by id (case-insensitive) or partial. */
export function findRequest(list: LeaveRequest[], ref: string): LeaveRequest {
  const needle = ref.trim().toLowerCase();
  const byId = list.find((r) => r.id.toLowerCase() === needle);
  if (byId) return byId;
  const pool = list.filter((r) => `${r.id} ${r.employeeId}`.toLowerCase().includes(needle));
  if (pool.length > 1) {
    throw new Error(`"${ref}" matches more than one request: ${pool.map((r) => `${r.id} (${r.employeeId} ${r.type})`).join(", ")}. Pass the exact id.`);
  }
  if (pool.length === 0) throw new Error(`no request matches "${ref}". Ids look like LV-0001. Run leave_list to see them.`);
  return pool[0];
}