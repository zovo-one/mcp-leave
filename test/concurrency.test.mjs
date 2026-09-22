// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
// Two server processes on one data dir, racing the same leave store.
//
// The store is read-modify-write under a file lock. Without the lock the second writer's
// snapshot is stale and its write silently drops the first writer's request, which reads
// on disk exactly like a leave request nobody ever filed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { client, sandbox, writeProfile, cleanup, proKey, request } from "./_client.mjs";

test("two processes, one store: every request survives", async (t) => {
  const box = sandbox("mcp-leave-conc-");
  writeProfile(box.dataHome);
  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await a.init();
  await b.init();
  const emp = await a.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  const empId = emp.id;

  // Six interleaved requests across the two processes, all non-overlapping.
  const calls = [];
  const spans = [
    ["2026-02-02", "2026-02-03"], ["2026-02-10", "2026-02-11"],
    ["2026-02-20", "2026-02-21"], ["2026-03-02", "2026-03-03"],
    ["2026-03-10", "2026-03-11"], ["2026-03-20", "2026-03-21"],
  ];
  for (let i = 0; i < 6; i++) {
    const who = i % 2 === 0 ? a : b;
    calls.push(who.call("leave_request", { employee: empId, type: "vacation", start: spans[i][0], end: spans[i][1] }));
  }
  for (const r of await Promise.all(calls)) assert.equal(r.isError, false, r.text);

  const list = await b.json("leave_list", {});
  assert.equal(list.requests.length, 6, "a request was lost to a stale snapshot");
  const bal = await b.json("leave_balance", { employee: empId });
  assert.equal(bal.pendingDays, 12, "the balance must count every surviving request");
});

test("two processes adding employees and requests at once never reuse an id", async (t) => {
  const box = sandbox("mcp-leave-ids-");
  writeProfile(box.dataHome);
  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await a.init();
  await b.init();

  const made = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    (i % 2 === 0 ? a : b).call("leave_employee_add", { name: `Person ${i}`, annualAllowance: 20 })));
  const empIds = made.map((r) => { assert.equal(r.isError, false, r.text); return JSON.parse(r.text).id; });
  assert.equal(new Set(empIds).size, 10, `an employee id was reused: ${empIds.sort().join(", ")}`);
  for (const id of empIds) assert.match(id, /^EMP-\d{4}$/);

  // Requests must also interleave without id reuse (distinct spans to avoid conflicts).
  const spans = Array.from({ length: 10 }, (_, i) => [`2026-05-${String(i * 2 + 1).padStart(2, "0")}`, `2026-05-${String(i * 2 + 1).padStart(2, "0")}`]);
  const reqs = await Promise.all(spans.map((s, i) =>
    (i % 2 === 0 ? a : b).call("leave_request", { employee: empIds[i], type: "vacation", start: s[0], end: s[1] })));
  const lvIds = reqs.map((r) => { assert.equal(r.isError, false, r.text); return JSON.parse(r.text).id; });
  assert.equal(new Set(lvIds).size, 10, `a request id was reused: ${lvIds.sort().join(", ")}`);
  for (const id of lvIds) assert.match(id, /^LV-\d{4}$/);
});

test("approving the same request from two processes converges to one approved state", async (t) => {
  const box = sandbox("mcp-leave-conc-");
  writeProfile(box.dataHome);
  const a = client({ dataHome: box.dataHome });
  const b = client({ dataHome: box.dataHome });
  t.after(() => { a.close(); b.close(); cleanup(box.dir); });
  await a.init();
  await b.init();
  const emp = await a.json("leave_employee_add", { name: "Ada Lovelace", annualAllowance: 25 });
  const lv = await request(a, emp.id, "vacation", "2026-02-16", "2026-02-17");
  const approvals = await Promise.all([
    a.call("leave_approve", { request: lv }),
    b.call("leave_approve", { request: lv }),
  ]);
  for (const r of approvals) assert.equal(r.isError, false, r.text);
  const list = await b.json("leave_list", { status: "approved" });
  assert.equal(list.requests.length, 1);
  const bal = await b.json("leave_balance", { employee: emp.id });
  assert.equal(bal.approvedDays, 2, "a double approval must not charge twice");
});
