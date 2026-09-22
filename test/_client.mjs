// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Shared stdio JSON-RPC client for the mcp-leave suites.
// One sandboxed data dir per client, so no test can see another's employees.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..");

export function proKey(product = "leave") {
  return "";
}

export function sandbox(prefix = "mcp-leave-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

/** The shared business profile every suite runs against. Only the name and address are used. */
export function writeProfile(dataHome, patch = {}) {
  const dir = join(dataHome, "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({
    name: "Nova Studio", address: "ul. Prosta 1, Warsaw", default_currency: "EUR",
    default_tax_rate: 23, payment_terms_days: 14, timezone: "Europe/Warsaw", ...patch,
  }, null, 2));
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-leave-")), "data");
  const env = { ...process.env, XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, "..", "config") };
  if (key) env.MCP_LICENSE_KEY = key; else delete env.MCP_LICENSE_KEY;
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    home, send,
    async init() {
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      return r.result;
    },
    async tools() { return (await send("tools/list", {})).result.tools; },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: r.result.isError === true };
    },
    async json(name, args) { const r = await this.call(name, args); if (r.isError) throw new Error(r.text); return JSON.parse(r.text); },
    close() { child.kill(); },
  };
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "leave"); }
export function storePath(dataHome) { return join(storeDir(dataHome), "store.json"); }

/* The worked example: a five-person studio, allowance 25 days + 1 carried. */

export const EMPLOYEES = [
  { name: "Ada Lovelace", annualAllowance: 25, carriedOver: 1 },
  { name: "Ben Okri", annualAllowance: 25, carriedOver: 0 },
  { name: "Cleo Patel", annualAllowance: 20, carriedOver: 2 },
  { name: "Ada Hopper", annualAllowance: 30, carriedOver: 0 },
];

/** Add the worked employees. Returns { name: id }. */
export async function seedEmployees(c, people = EMPLOYEES) {
  const ids = {};
  for (const p of people) {
    const r = await c.call("leave_employee_add", p);
    if (r.isError) throw new Error(`leave_employee_add ${p.name}: ${r.text}`);
    ids[p.name] = JSON.parse(r.text).id;
  }
  return ids;
}

/** Add one pending request. Returns its LV id. */
export async function request(c, employee, type, start, end, extra = {}) {
  const r = await c.call("leave_request", { employee, type, start, end, ...extra });
  if (r.isError) throw new Error(`leave_request ${employee} ${start}..${end}: ${r.text}`);
  return JSON.parse(r.text).id;
}

/**
 * The worked scenario:
 *   Ada Lovelace  LV-0001 vacation 2026-02-16..2026-02-18 (3 days)        approved
 *                 LV-0002 sick    2026-03-02..2026-03-02 (half day)      pending
 *   Ben Okri      LV-0003 vacation 2026-02-17..2026-02-20 (4 days)        approved
 *   Cleo Patel    LV-0004 parental 2026-04-06..2026-04-10 (5 days)        pending
 * Ada's committed = 3.5 days of 26 -> remaining 22 whole days (45 halves).
 */
export async function seed(c) {
  const ids = await seedEmployees(c);
  const lv1 = await request(c, ids["Ada Lovelace"], "vacation", "2026-02-16", "2026-02-18", { reason: "Family trip" });
  await c.call("leave_approve", { request: lv1, comment: "ok" });
  const lv2 = await request(c, ids["Ada Lovelace"], "sick", "2026-03-02", "2026-03-02", { halfDay: true });
  const lv3 = await request(c, ids["Ben Okri"], "vacation", "2026-02-17", "2026-02-20");
  await c.call("leave_approve", { request: lv3 });
  const lv4 = await request(c, ids["Cleo Patel"], "parental", "2026-04-06", "2026-04-10", { reason: "Care" });
  return { ids, requests: [lv1, lv2, lv3, lv4] };
}
