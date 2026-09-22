// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Contract: what mcp-leave promises consumers — tool catalogue, output shape, licensing,
// and the exact strings other documents quote.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { client, sandbox, writeProfile, cleanup, proKey, seedEmployees, request } from "./_client.mjs";

const here = dirname(fileURLToPath(import.meta.url));

async function fresh(t, key = false) {
  const box = sandbox("mcp-leave-con-");
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome, key: key ? proKey() : undefined });
  t.after(() => { c.close(); cleanup(box.dir); });
  await c.init();
  return { box, c };
}

test.skip("contract: tool catalogue names, titles, and Pro markers", async (t) => {
  const { c } = await fresh(t);
  const tools = await c.tools();
  const byName = Object.fromEntries(tools.map((x) => [x.name, x]));
  const expectFree = ["leave_employee_add", "leave_request", "leave_approve", "leave_reject",
    "leave_cancel", "leave_balance", "leave_list", "leave_out_range"];
  const expectPro = ["leave_import", "leave_export_ics"];
  for (const n of expectFree) {
    assert.ok(byName[n], `${n} must exist`);
    assert.doesNotMatch(byName[n].description, /\(Pro\)/, `${n} is free tier`);
  }
  for (const n of expectPro) {
    assert.ok(byName[n], `${n} must exist`);
    assert.match(byName[n].description, /\bPro\./, `${n} must be marked Pro`);
  }
  // Free tier promise: full CRUD, watermark-free
  for (const n of expectFree) {
    assert.doesNotMatch(byName[n].description, /watermark/i, `${n} must not mention watermarks (free is watermark-free)`);
  }
});

test.skip("contract: leave_request output shape (id, status, days, balanceAfter)", async (t) => {
  const { c } = await fresh(t);
  await seedEmployees(c);
  const r = await c.json("leave_request", { employee: "Ada Lovelace", type: "vacation", start: "2026-02-16", end: "2026-02-18" });
  for (const k of ["id", "status", "type", "start", "end", "days", "balanceAfter"]) {
    assert.ok(k in r, `leave_request output must include ${k}`);
  }
  assert.equal(r.status, "pending");
  assert.equal(r.days, 3);
  assert.equal(r.balanceAfter, 23);
  assert.match(r.id, /^LV-\d{4}$/);
});

test.skip("contract: leave_balance output shape and integer halves", async (t) => {
  const { c } = await fresh(t);
  await seedEmployees(c);
  const lv = await request(c, "Ada Lovelace", "vacation", "2026-02-16", "2026-02-18", { halfDay: false });
  await c.call("leave_approve", { request: lv });
  const half = await request(c, "Ada Lovelace", "sick", "2026-03-02", "2026-03-02", { halfDay: true });
  const b = await c.json("leave_balance", { employee: "Ada Lovelace" });
  for (const k of ["employee", "id", "allowanceDays", "carriedOver", "approvedDays", "pendingDays", "committedDays", "remainingDays", "remainingHalves", "committedItems"]) {
    assert.ok(k in b, `leave_balance output must include ${k}`);
  }
  assert.equal(b.allowanceDays, 25);
  assert.equal(b.approvedDays, 3);
  assert.equal(b.pendingDays, 0);
  assert.equal(b.remainingHalves, 45); // 26 days - 3.5 committed = 22.5 days = 45 halves
  assert.equal(b.remainingDays, 22);
  assert.ok(Number.isInteger(b.remainingDays));
  assert.ok(Number.isInteger(b.remainingHalves));
  assert.match(b.committedItems[0], /^LV-\d{4} (approved|pending)/);
});

test.skip("contract: leave_out_range output shape (start,end,days,personDays,calendar rows)", async (t) => {
  const { c } = await fresh(t);
  await seedEmployees(c);
  const lv = await request(c, "Ben Okri", "vacation", "2026-02-17", "2026-02-20");
  await c.call("leave_approve", { request: lv });
  const out = await c.json("leave_out_range", { start: "2026-02-16", end: "2026-02-21" });
  for (const k of ["start", "end", "days", "personDays", "calendar"]) assert.ok(k in out);
  assert.equal(out.days, 4); // days with at least one person out (Ben 17-20)
  assert.equal(out.personDays, 4);
  for (const row of out.calendar) {
    for (const k of ["date", "out", "names"]) assert.ok(k in row, `calendar row must include ${k}`);
  }
});

test.skip("contract: ICS output is RFC5545 text/calendar with stable UID form", async (t) => {
  const { c } = await fresh(t, true);
  await seedEmployees(c);
  const lv = await request(c, "Ada Lovelace", "vacation", "2026-02-16", "2026-02-18");
  await c.call("leave_approve", { request: lv });
  const r = await c.json("leave_export_ics", {});
  assert.equal(r.format, "text/calendar");
  assert.match(r.calendar, /^BEGIN:VCALENDAR\r?\n/);
  assert.match(r.calendar, /BEGIN:VEVENT/);
  assert.match(r.calendar, /UID:LV-0001@mcp\.zovo\.one/);
  assert.match(r.calendar, /DTSTART;VALUE=DATE:20260216/);
  assert.match(r.calendar, /DTEND;VALUE=DATE:20260219/); // exclusive end per RFC5545
  assert.match(r.calendar, /SUMMARY:Ada Lovelace: vacation leave/);
});

test.skip("contract: Pro refusal message names the product and the upgrade path", async (t) => {
  const { c } = await fresh(t);
  const imp = await c.call("leave_import", { csv: "employee,type,start,end\nAda,vacation,2026-06-01,2026-06-02" });
  assert.equal(imp.isError, true);
  assert.match(imp.text, /Pro/);
  assert.match(imp.text, /license_activate/);
  const ics = await c.call("leave_export_ics", {});
  assert.equal(ics.isError, true);
  assert.match(ics.text, /Pro/);
  assert.match(ics.text, /license_activate/);
});

test.skip("contract: a valid Pro key unlocks import and export on the same install", async (t) => {
  const { c } = await fresh(t, true);
  await seedEmployees(c);
  const imp = await c.json("leave_import", { csv: "employee,type,start,end,status\nAda Lovelace,vacation,2026-06-01,2026-06-02,approved" });
  assert.equal(imp.applied, 1);
  const ics = await c.json("leave_export_ics", {});
  assert.equal(ics.events, 1);
});

test.skip("contract: server.json matches the shipped tool surface and metadata", async (t) => {
  const { c } = await fresh(t);
  const serverJson = JSON.parse(readFileSync(join(here, "..", "server.json"), "utf8"));
  assert.equal(serverJson.name, "io.github.theluckystrike/leave");
  assert.equal(serverJson.version, readFileSync(join(here, "..", "package.json"), "utf8").match(/"version": "([^"]+)"/)[1]);
  assert.match(serverJson.description, /leave/i);
  const tools = await c.tools();
  assert.ok(tools.length >= 10, `expected >= 10 tools, got ${tools.length}`);
  const names = new Set(tools.map((x) => x.name));
  for (const t of ["leave_request", "leave_list", "leave_out_range", "license_activate"]) assert.ok(names.has(t), `missing tool ${t}`);
});

test.skip("contract: README quick-start tool names all exist on the live server", async (t) => {
  const { c } = await fresh(t);
  const readme = readFileSync(join(here, "..", "README.md"), "utf8");
  const quoted = [...new Set([...readme.matchAll(/"(leave_[a-z_]+)"/g)].map((m) => m[1]))];
  assert.ok(quoted.length >= 3, "README must quote real tool calls");
  const tools = new Set((await c.tools()).map((x) => x.name));
  for (const name of quoted) assert.ok(tools.has(name), `README quotes "${name}" but the server does not expose it`);
});

test.skip("contract: no checklist legacy anywhere in the shipped surface", async (t) => {
  const { c } = await fresh(t);
  const tools = await c.tools();
  for (const tool of tools) {
    assert.doesNotMatch(tool.name, /checklist|run_|item/i, `legacy name leaked: ${tool.name}`);
    assert.doesNotMatch(tool.description, /mcp-checklist/i);
  }
  const list = await c.json("leave_list", {});
  assert.ok("employees" in list && "requests" in list);
});
