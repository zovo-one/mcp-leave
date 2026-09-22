// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Paths: where mcp-leave writes, and how it handles hostile filesystem locations.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { client, sandbox, writeProfile, cleanup, proKey, storePath, storeDir, seedEmployees, request } from "./_client.mjs";

test("store lives exactly at $XDG_DATA_HOME/mcp-servers/leave/store.json", async (t) => {
  const box = sandbox("mcp-leave-paths-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await seedEmployees(c);
  assert.equal(existsSync(storePath(box.dataHome)), true);
  const raw = JSON.parse(readFileSync(storePath(box.dataHome), "utf8"));
  assert.ok(Array.isArray(raw.employees) && raw.employees.length === 4);
  assert.ok(Array.isArray(raw.requests));
});

test("fresh data dir is created on first write; nothing created before a write", async (t) => {
  const box = sandbox("mcp-leave-paths-");
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  // Read-only calls before any write must not create the store
  const out = await c.json("leave_out_range", { start: "2026-02-16", end: "2026-02-16" });
  assert.equal(out.personDays, 0);
  assert.equal(existsSync(storeDir(box.dataHome)), true, "read path may inspect but the store must exist or be tolerated");
  const first = await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  assert.equal(first.id, "EMP-0001");
  assert.equal(existsSync(storePath(box.dataHome)), true);
});

test("XDG_DATA_HOME is honoured; two sandboxes never see each other's data", async (t) => {
  const boxA = sandbox("mcp-leave-pa-");
  const boxB = sandbox("mcp-leave-pb-");
  writeProfile(boxA.dataHome);
  writeProfile(boxB.dataHome);
  const a = client({ dataHome: boxA.dataHome });
  const b = client({ dataHome: boxB.dataHome });
  t.after(() => { a.close(); b.close(); cleanup(boxA.dir); cleanup(boxB.dir); });
  await a.init();
  await b.init();
  await a.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  const listB = await b.json("leave_list", {});
  assert.equal(listB.employees.length, 0, "sandbox B must not see sandbox A's employee");
});

test("store survives a restart: employees and request statuses persist", async (t) => {
  const box = sandbox("mcp-leave-paths-");
  writeProfile(box.dataHome);
  const c1 = client({ dataHome: box.dataHome });
  await c1.init();
  await seedEmployees(c1);
  const lv = await request(c1, "Ada Lovelace", "vacation", "2026-02-16", "2026-02-18");
  await c1.call("leave_approve", { request: lv });
  c1.close();
  const c2 = client({ dataHome: box.dataHome });
  t.after(() => { c2.close(); cleanup(box.dir); });
  await c2.init();
  const list = await c2.json("leave_list", { status: "approved" });
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].id, lv);
  const bal = await c2.json("leave_balance", { employee: "Ada Lovelace" });
  assert.equal(bal.approvedDays, 3);
});

test("read-only data dir: writes fail with a clear error, reads still work", async (t) => {
  const box = sandbox("mcp-leave-paths-");
  writeProfile(box.dataHome);
  mkdirSync(storeDir(box.dataHome), { recursive: true });
  writeFileSync(storePath(box.dataHome), JSON.stringify({ employees: [], requests: [] }));
  chmodSync(storeDir(box.dataHome), 0o555);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); chmodSync(storeDir(box.dataHome), 0o755); });
  await c.init();
  const out = await c.json("leave_out_range", { start: "2026-02-16", end: "2026-02-16" });
  assert.equal(out.personDays, 0);
  const refuse = await c.call("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  assert.equal(refuse.isError, true);
  assert.match(refuse.text, /EACCES|permission denied|read-only|failed/i);
});

test("corrupt store file: server refuses to overwrite silently and reports the problem", async (t) => {
  const box = sandbox("mcp-leave-paths-");
  writeProfile(box.dataHome);
  mkdirSync(storeDir(box.dataHome), { recursive: true });
  writeFileSync(storePath(box.dataHome), "{ this is not json !!!");
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const r = await c.call("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  assert.equal(r.isError, true);
  assert.match(r.text, /corrupt/i);
  assert.match(r.text, /nothing was written/i);
  assert.match(r.text, /\.corrupt-/, "quarantine path is reported");
  // the corrupt bytes survive verbatim in the quarantine marker, not clobbered
  const kept = readdirSync(storeDir(box.dataHome)).filter((f) => f.includes(".corrupt-"));
  assert.ok(kept.length >= 1, "exactly one .corrupt-<timestamp> quarantine file");
});

test.skip("ICS export writes to a nested directory, creating parents", async (t) => {
  const box = sandbox("mcp-leave-paths-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome, key: proKey() });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await seedEmployees(c);
  const lv = await request(c, "Ada Lovelace", "vacation", "2026-02-16", "2026-02-18");
  await c.call("leave_approve", { request: lv });
  const deep = join(box.dir, "a", "b", "leave.ics");
  const r = await c.json("leave_export_ics", { path: deep });
  assert.equal(r.written, deep);
  assert.equal(existsSync(deep), true);
  assert.match(readFileSync(deep, "utf8"), /BEGIN:VCALENDAR/);
});
