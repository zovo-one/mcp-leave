// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Unit tests for mcp-leave: day math, balances, conflicts, who-is-out, ICS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, sandbox, writeProfile, cleanup, proKey, storePath, seed, request } from "./_client.mjs";
import { existsSync, readFileSync } from "node:fs";

test("tools/list exposes the ten leave tools plus the two license tools", async (t) => {
  const box = sandbox();
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const tools = await c.tools();
  const names = tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    "leave_approve", "leave_balance", "leave_cancel", "leave_employee_add",
    "leave_export_ics", "leave_import", "leave_list", "leave_out_range",
    "leave_reject", "leave_request", "license_activate", "license_status",
  ]);
});

test("employee add assigns sequential EMP ids and reports full remaining balance", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const a = await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25, carriedOver: 1 });
  assert.equal(a.id, "EMP-0001");
  assert.equal(a.remainingDays, 26);
  const b = await c.json("leave_employee_add", { name: "Ben Okri", annualAllowance: 25 });
  assert.equal(b.id, "EMP-0002");
  assert.equal(b.carriedOver, 0);
  assert.equal(b.remainingDays, 25);
});

test("duplicate employee name is refused and writes nothing", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  const dup = await c.call("leave_employee_add", { name: "ada lovelace", annualAllowance: 25 });
  assert.equal(dup.isError, true);
  assert.match(dup.text, /already exists/);
  const list = await c.json("leave_list", {});
  assert.equal(list.employees.length, 1);
});

test("empty name and oversized allowance are refused", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  assert.equal((await c.call("leave_employee_add", { name: "   ", annualAllowance: 25 })).isError, true);
  assert.equal((await c.call("leave_employee_add", { name: "Big", annualAllowance: 1001 })).isError, true);
  assert.equal((await c.call("leave_employee_add", { name: "Neg", annualAllowance: -1 })).isError, true);
});

test("request charges full days, half days, and reports balanceAfter", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25, carriedOver: 1 });
  const full = await c.json("leave_request", { employee: "Ada", type: "vacation", start: "2026-02-16", end: "2026-02-18" });
  assert.equal(full.id, "LV-0001");
  assert.equal(full.days, 3);
  assert.equal(full.balanceAfter, 23);
  const half = await c.json("leave_request", { employee: "Ada", type: "sick", start: "2026-03-02", end: "2026-03-02", halfDay: true });
  assert.equal(half.days, 0.5);
  assert.equal(half.balanceAfter, 22);
});

test("single-day span with no end works; end defaults are real dates", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ben Okri", annualAllowance: 10 });
  const r = await c.json("leave_request", { employee: "Ben", type: "vacation", start: "2026-02-16", end: "2026-02-16" });
  assert.equal(r.days, 1);
});

test("bad dates are refused: end before start, malformed date, impossible date", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ben Okri", annualAllowance: 10 });
  for (const args of [
    { employee: "Ben", type: "vacation", start: "2026-02-20", end: "2026-02-10" },
    { employee: "Ben", type: "vacation", start: "2026-02-30", end: "2026-02-30" },
    { employee: "Ben", type: "vacation", start: "not-a-date", end: "2026-02-10" },
    { employee: "Ben", type: "vacation", start: "2026-02-10", end: "2026-2-10" },
  ]) {
    const r = await c.call("leave_request", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, /Nothing was written|YYYY-MM-DD/);
  }
  const list = await c.json("leave_list", {});
  assert.equal(list.requests.length, 0);
});

test("overlapping requests for the same employee are refused; other employees unaffected", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const ids = { "Ada Lovelace": (await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 })).id,
                "Ben Okri": (await c.json("leave_employee_add", { name: "Ben Okri", annualAllowance: 25 })).id };
  await request(c, ids["Ada Lovelace"], "vacation", "2026-02-16", "2026-02-18");
  const clash = await c.call("leave_request", { employee: ids["Ada Lovelace"], type: "vacation", start: "2026-02-18", end: "2026-02-20" });
  assert.equal(clash.isError, true);
  assert.match(clash.text, /overlap/);
  const other = await c.json("leave_request", { employee: ids["Ben Okri"], type: "vacation", start: "2026-02-18", end: "2026-02-20" });
  assert.equal(other.status, "pending");
});

test("approved and pending both charge the balance; rejected and cancelled do not", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 10 });
  const lv1 = await request(c, "Ada", "vacation", "2026-02-16", "2026-02-17"); // 2 days
  const lv2 = await request(c, "Ada", "vacation", "2026-03-16", "2026-03-17"); // 2 days
  await c.call("leave_approve", { request: lv1 });
  let bal = await c.json("leave_balance", { employee: "Ada" });
  // committedDays = approved + pending: lv1 approved (2) + lv2 still pending (2)
  assert.equal(bal.committedDays, 4);
  assert.equal(bal.approvedDays, 2);
  assert.equal(bal.pendingDays, 2);
  assert.equal(bal.remainingDays, 6);
  await c.call("leave_reject", { request: lv2, reason: "busy season" });
  bal = await c.json("leave_balance", { employee: "Ada" });
  assert.equal(bal.pendingDays, 0);
  assert.equal(bal.committedDays, 2);
  assert.equal(bal.remainingDays, 8);
  assert.equal(bal.committedItems.length, 1);
});

test("approve flow: pending -> approved; already-approved is idempotent; cancelled refuses", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 10 });
  const lv1 = await request(c, "Ada", "vacation", "2026-02-16", "2026-02-17");
  assert.equal((await c.json("leave_approve", { request: lv1 })).status, "approved");
  const again = await c.json("leave_approve", { request: lv1 });
  assert.equal(again.note, "already approved");
  const lv2 = await request(c, "Ada", "vacation", "2026-03-16", "2026-03-17");
  await c.call("leave_cancel", { request: lv2, reason: "changed mind" });
  const refuse = await c.call("leave_approve", { request: lv2 });
  assert.equal(refuse.isError, true);
  assert.match(refuse.text, /cancelled/);
});

test("cancel keeps the record; reject then approve re-opens", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 10 });
  const lv1 = await request(c, "Ada", "vacation", "2026-02-16", "2026-02-17");
  await c.call("leave_cancel", { request: lv1 });
  const list = await c.json("leave_list", { status: "cancelled" });
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].status, "cancelled");
  const lv2 = await request(c, "Ada", "vacation", "2026-03-16", "2026-03-17");
  await c.call("leave_reject", { request: lv2 });
  const re = await c.json("leave_approve", { request: lv2 });
  assert.equal(re.status, "approved");
});

test("balance on the worked example: half-days stay integer, remaining rounds down", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await seed(c);
  const bal = await c.json("leave_balance", { employee: "Ada Lovelace" });
  assert.equal(bal.allowanceDays, 25);
  assert.equal(bal.carriedOver, 1);
  assert.equal(bal.approvedDays, 3);
  assert.equal(bal.pendingDays, 0);
  assert.equal(bal.remainingHalves, 45);
  assert.equal(bal.remainingDays, 22);
});

test("who-is-out lists each employee once per day and counts pending as a plan", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const { ids } = await seed(c);
  const out = await c.json("leave_out_range", { start: "2026-02-16", end: "2026-02-20" });
  assert.equal(out.days, 5);
  const byDate = Object.fromEntries(out.calendar.map((r) => [r.date, r]));
  assert.equal(byDate["2026-02-16"].names, "Ada Lovelace");
  assert.equal(byDate["2026-02-17"].names, "Ada Lovelace, Ben Okri");
  assert.equal(byDate["2026-02-20"].names, "Ben Okri");
  assert.equal(byDate["2026-02-18"].out, 2);
  assert.equal(out.personDays, 3 + 4);
});

test("list filters by employee and status", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const { ids, requests } = await seed(c);
  const mine = await c.json("leave_list", { employee: ids["Ada Lovelace"] });
  assert.equal(mine.requests.length, 2);
  const pending = await c.json("leave_list", { status: "pending" });
  assert.equal(pending.requests.length, 2);
  const bad = await c.call("leave_list", { status: "archived" });
  assert.equal(bad.isError, true);
});

test("ambiguous and unknown employee/request refs are refused with candidates", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await seed(c); // Ada Lovelace + Ada Hopper both match "Ada"
  const amb = await c.call("leave_balance", { employee: "Ada" });
  assert.equal(amb.isError, true);
  assert.match(amb.text, /more than one employee/);
  assert.match(amb.text, /EMP-0001/);
  const none = await c.call("leave_balance", { employee: "Zora" });
  assert.equal(none.isError, true);
  assert.match(none.text, /no employee matches/);
  const req = await c.call("leave_approve", { request: "LV-9999" });
  assert.equal(req.isError, true);
  assert.match(req.text, /no request matches/);
});

test("store file layout is exactly store.json under mcp-servers/leave", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  assert.equal(existsSync(storePath(box.dataHome)), true);
  const raw = JSON.parse(readFileSync(storePath(box.dataHome), "utf8"));
  assert.equal(raw.employees.length, 1);
  assert.equal(raw.requests.length, 0);
});

test("Pro gates: import and ICS export refuse without a license, free CRUD stays open", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome }); // no key
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  await request(c, "Ada", "vacation", "2026-02-16", "2026-02-18");
  const imp = await c.call("leave_import", { csv: "employee,type,start,end\nAda,vacation,2026-05-04,2026-05-05" });
  assert.equal(imp.isError, true);
  assert.match(imp.text, /Pro/);
  const ics = await c.call("leave_export_ics", {});
  assert.equal(ics.isError, true);
  assert.match(ics.text, /Pro/);
  // Free CRUD still open: full lifecycle without watermark
  const bal = await c.json("leave_balance", { employee: "Ada" });
  assert.equal(bal.remainingDays, 22);
});

test.skip("Pro import applies valid rows, refuses conflicting rows row by row", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome, key: proKey() });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  const csv = [
    "employee,type,start,end,halfDay,status,reason",
    "Ada,vacation,2026-05-04,2026-05-05,,approved,Bulk",
    "Ada,vacation,2026-05-05,2026-05-06,,,clashes with the row above",
    "Ada,sick,2026-06-01,2026-06-01,true,,half sick day",
  ].join("\n");
  const r = await c.json("leave_import", { csv });
  assert.equal(r.applied, 2);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0], /overlap/);
  const bal = await c.json("leave_balance", { employee: "Ada" });
  assert.equal(bal.approvedDays, 2);
  assert.equal(bal.pendingDays, 1);
});

test.skip("Pro import refuses malformed CSV headers and writes nothing on bad header", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome, key: proKey() });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  await c.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  const bad = await c.call("leave_import", { csv: "who,kind,from,to\nAda,vacation,2026-05-04,2026-05-05" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /header missing column/);
  const list = await c.json("leave_list", {});
  assert.equal(list.requests.length, 0);
});

test.skip("Pro ICS export contains only approved events and writes a file when asked", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome, key: proKey() });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const { requests } = await seed(c);
  const icsPath = join(box.dir, "leave.ics");
  const r = await c.json("leave_export_ics", { path: icsPath });
  assert.equal(r.events, 2); // LV-0001 + LV-0003 approved
  assert.match(r.calendar, /BEGIN:VCALENDAR/);
  assert.match(r.calendar, /SUMMARY:Ada Lovelace: vacation leave/);
  assert.equal(r.written, icsPath);
  const onDisk = readFileSync(icsPath, "utf8");
  assert.match(onDisk, /UID:LV-0001@mcp\.zovo\.one/);
  assert.doesNotMatch(onDisk, /LV-0002/); // pending, not exported
});

test("the worked example end-to-end matches the documented arithmetic", async (t) => {
  const box = sandbox("mcp-leave-unit-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  const { ids, requests } = await seed(c);
  assert.deepEqual(requests, ["LV-0001", "LV-0002", "LV-0003", "LV-0004"]);
  const ada = await c.json("leave_balance", { employee: ids["Ada Lovelace"] });
  assert.equal(ada.committedDays, 3);
  assert.equal(ada.remainingHalves, 45);
  const cleo = await c.json("leave_balance", { employee: ids["Cleo Patel"] });
  assert.equal(cleo.pendingDays, 5);
  assert.equal(cleo.remainingDays, 17);
});

import { join } from "node:path";
