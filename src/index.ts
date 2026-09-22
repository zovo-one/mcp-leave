#!/usr/bin/env node
/**
 * mcp-leave: employee leave and PTO requests — balances, approvals, calendars and
 * who-is-out summaries.
 *
 * The rules behind the tools live in src/leave.ts: an employee's balance is
 *   allowance + carriedOver - approved - pending
 * computed over whole days plus a possible half-day, an overlapping pair of requests for
 * the same employee is a conflict, and who-is-out spans a date range and lists each
 * employee once per day. All day arithmetic is INTEGER (half-days under the hood, never a
 * binary float).
 *
 * Free tier is full CRUD with no watermark. Pro (MCP_LICENSE_KEY, mirroring the checklist
 * sibling) adds bulk CSV import and an ICS/calendar export.
 */
import { mkdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, isAbsolute, resolve as resolvePath } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLicenseGate, readSharedProfile, withFileLock } from "@theluckystrike/mcp-license";
import { isIsoDate, today } from "@theluckystrike/mcp-quotes/lib";
import { z } from "zod";
import { VERSION } from "./version.js";
import {
  LEAVE_STATUSES, LEAVE_TYPES, MAX_ALLOWANCE, MAX_NAME, MAX_REASON,
  balance, chargeHalves, findConflicts, overlapDays, whoIsOut,
  type Employee, type LeaveRequest, type LeaveType,
} from "./leave.js";
import {
  findEmployee, findRequest, getEmployees, getRequests, lockPath,
  nextEmployeeId, nextRequestId, setEmployees, setRequests,
} from "./store.js";

const gate = createLicenseGate({ product: "leave" });

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true as const });
const json = (v: unknown) => ok(JSON.stringify(v, null, 2));

const str = (field: string, max: number) => z.string().max(max, `${field} must be ${max} characters or fewer`);
const iso = (field: string) => str(field, 32).refine((v) => isIsoDate(v), `${field} must be a real date in YYYY-MM-DD form`);

/** Only this server's own store is written, so there is one lock and it is this one. */
function locked<T>(fn: () => T): Promise<T> {
  return withFileLock(lockPath(), fn, { timeoutMs: 20000 });
}

function requirePro(feature: string, toolName: string): void {
  if (!gate.isPro()) throw new Error(`${feature} is Pro. Nothing was written. ${gate.upgradeText(feature, toolName)}`);
}

function normName(s: string): string {
  const n = s.trim();
  if (!n) throw new Error("name is empty. Every employee needs a name. Nothing was written.");
  if (n.length > MAX_NAME) throw new Error(`name must be ${MAX_NAME} characters or fewer. Nothing was written.`);
  return n;
}

function loadAll(): { employees: Employee[]; requests: LeaveRequest[] } {
  return { employees: getEmployees(), requests: getRequests() };
}

/** Save both sides together so employee/request invariants never straddle a torn write. */
function saveAll(employees: Employee[], requests: LeaveRequest[]): void {
  setRequests(requests);
  setEmployees(employees);
}

/** Overlap check helper: does this request clash with any other request of the same employee? */
function assertNoConflict(reqs: LeaveRequest[], candidate: LeaveRequest): void {
  const clash = reqs.find((r) =>
    r.id !== candidate.id && r.employeeId === candidate.employeeId &&
    (r.status === "approved" || r.status === "pending") &&
    (candidate.status === "approved" || candidate.status === "pending") &&
    overlapDays(r.start, r.end, candidate.start, candidate.end) > 0,
  );
  if (clash) {
    throw new Error(`that would overlap ${clash.id} (${clash.start}..${clash.end}, ${clash.type}, ${clash.status}) for the same employee. Resolve the overlap first. Nothing was written.`);
  }
}

function endAfterStart(start: string, end: string): void {
  if (end < start) throw new Error(`end (${end}) is before start (${start}). Nothing was written.`);
}

/** One request line for ICS export; escape text per RFC 5545. */
function icsEscape(s: string): string {
  return s.replace(/([\\;,])/g, "\\$1").replace(/\r?\n/g, "\\n");
}

function icsDate(d: string): string { return d.replace(/-/g, ""); }

function dayAfter(d: string): string {
  const [y, m, day] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day + 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

function buildIcs(requests: LeaveRequest[], employees: Employee[]): string {
  const nameById = new Map<string, string>();
  for (const e of employees) nameById.set(e.id, e.name);
  const approved = requests.filter((r) => r.status === "approved");
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//theluckystrike//mcp-leave//EN",
    "CALSCALE:GREGORIAN",
  ];
  for (const r of approved) {
    const uid = `${r.id}@mcp.zovo.one`;
    const emp = nameById.get(r.employeeId) ?? "unknown";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${icsDate(today())}T000000Z`,
      `DTSTART;VALUE=DATE:${icsDate(r.start)}`,
      `DTEND;VALUE=DATE:${icsDate(dayAfter(r.end))}`,
      `SUMMARY:${icsEscape(`${emp}: ${r.type} leave`)}`,
    );
    if (r.reason) lines.push(`DESCRIPTION:${icsEscape(r.reason)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

const now = () => new Date().toISOString();

/* ------------------------------------------------------------------- server */

const server = new McpServer(
  { name: "mcp-leave", version: VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

const employeeRef = str("employee", MAX_NAME).describe("The employee id (e.g. EMP-0001) or a name; a unique partial name works.");
const reqRef = str("request", MAX_NAME).describe("The request id (e.g. LV-0001).");

function loadEmployee(employees: Employee[], ref: string): Employee { return findEmployee(employees, ref); }

server.registerTool("leave_employee_add", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Add an employee",
  description: "Add an employee to the leave tracker and return their EMP-NNNN id. Give their annual paid-leave allowance in whole days and any days carried over from last year. Balances charge approved plus pending leave against allowance + carried-over. Free tier: unlimited.",
  inputSchema: {
    name: str("name", MAX_NAME).describe("Full name, e.g. Taylor Wren"),
    annualAllowance: z.number().int().min(0).max(MAX_ALLOWANCE).describe("Annual paid leave allowance in whole days"),
    carriedOver: z.number().int().min(0).max(MAX_ALLOWANCE).optional().describe("Days carried over from last year (default 0)"),
    email: str("email", 200).optional().describe("Work email, for calendar lookup"),
  },
}, async (a: { name: string; annualAllowance: number; carriedOver?: number; email?: string }) => {
  try {
    const name = normName(a.name);
    return locked(() => {
      const { employees, requests } = loadAll();
      if (employees.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
        throw new Error(`an employee named "${name}" already exists (${employees.find((e) => e.name.toLowerCase() === name.toLowerCase())!.id}). Use them. Nothing was written.`);
      }
      const emp: Employee = {
        id: nextEmployeeId(employees.map((e) => e.id)),
        name,
        annualAllowance: Math.floor(a.annualAllowance ?? 0),
        carriedOver: Math.floor(a.carriedOver ?? 0),
      };
      saveAll([...employees, emp], requests);
      const b = balance(emp, []);
      return json({ id: emp.id, name: emp.name, annualAllowance: b.allowanceDays, carriedOver: b.carriedOver, remainingDays: b.remainingDays, note: "Balance is computed as allowance + carried - approved - pending." });
    });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

server.registerTool("leave_request", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Request leave",
  description: "Create a leave or PTO request and return its LV-NNNN id. type is vacation, sick, unpaid or parental. start and end are inclusive YYYY-MM-DD dates; halfDay charges half a day for the whole span. A pending request is refussed if it would overlap another approved or pending request of the same employee. Free tier: unlimited requests.",
  inputSchema: {
    employee: str("employee", MAX_NAME).describe("The employee id or name"),
    type: z.enum(["vacation", "sick", "unpaid", "parental"]).describe("Kind of leave"),
    start: iso("start").describe("First day off, YYYY-MM-DD, inclusive"),
    end: str("end", 32).describe("Last day off, YYYY-MM-DD, inclusive").refine((v) => v === undefined || isIsoDate(v), "end must be a real date in YYYY-MM-DD form"),
    halfDay: z.boolean().optional().describe("Half-day charge for the whole span (default false)"),
    reason: str("reason", MAX_REASON).optional().describe("Why, shown in reports and calendar"),
  },
}, async (a: { employee: string; type: LeaveType; start: string; end: string; halfDay?: boolean; reason?: string }) => {
  try {
    const type = a.type;
    if (!LEAVE_TYPES.includes(type)) throw new Error(`type must be ${LEAVE_TYPES.join(", ")}. Nothing was written.`);
    const halfDay = !!a.halfDay;
    return locked(() => {
      const { employees, requests } = loadAll();
      const emp = loadEmployee(employees, a.employee);
      const start = a.start;
      const end = a.end;
      endAfterStart(start, end);
      const cand: LeaveRequest = {
        id: "", // assigned belowthrough nextRequestId
        employeeId: emp.id,
        type,
        start, end,
        halfDay,
        status: "pending",
        reason: a.reason?.trim() || undefined,
      };
      assertNoConflict(requests, cand);
      cand.id = nextRequestId(requests.map((r) => r.id));
      const nextReqs = [...requests, cand];
      saveAll(employees, nextReqs);
      const b = balance(emp, nextReqs.filter((r) => r.employeeId === emp.id));
      const days = chargeHalves(cand);
      return json({ id: cand.id, employeeId: emp.id, type, start, end, halfDay, status: "pending", days: days / 2, balanceAfter: b.remainingDays, note: "Half-day charged as 0.5 day." });
    });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

server.registerTool("leave_approve", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Approve leave",
  description: "Approve a pending leave request by id. Also used to re-open a rejected one. Nothing to approve on an already-approved request.",
  inputSchema: { request: reqRef, comment: str("comment", MAX_REASON).optional().describe("Approval note") },
}, async (a: { request: string; comment?: string }) => {
  try {
    return locked(() => {
      const { employees, requests } = loadAll();
      const req = findRequest(requests, a.request);
      const emp = employees.find((e) => e.id === req.employeeId);
      if (req.status === "approved") return json({ id: req.id, status: req.status, note: "already approved" });
      if (req.status === "cancelled") throw new Error(`${req.id} is cancelled and cannot be approved. Create a new request. Nothing was written.`);
      const cand = { ...req, status: "approved" as const };
      assertNoConflict(requests, cand);
      const next = requests.map((r) => r.id === req.id ? cand : r);
      saveAll(employees, next);
      const b = emp ? balance(emp, next.filter((r) => r.employeeId === emp.id)) : null;
      return json({ id: cand.id, status: "approved", ...(emp ? { balanceDays: b?.remainingDays } : {}) });
    });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

server.registerTool("leave_reject", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Reject leave",
  description: "Reject or cancel a leave request by id. A pending or approved request becomes rejected; a rejected one can be reopened via leave_approve. Use leave_cancel (via reject with reason) for voluntary withdrawal.",
  inputSchema: { request: reqRef, reason: str("reason", MAX_REASON).optional().describe("Why") },
}, async (a: { request: string; reason?: string }) => {
  try {
    return locked(() => {
      const { employees, requests } = loadAll();
      const req = findRequest(requests, a.request);
      if (req.status === "rejected") return json({ id: req.id, status: req.status, note: "already rejected" });
      const next = requests.map((r) => r.id === req.id ? { ...req, status: "rejected" as const } : r);
      saveAll(employees, next);
      return json({ id: req.id, status: "rejected", note: req.reason || null });
    });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

server.registerTool("leave_balance", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Leave balance",
  description: "Show one employee's leave balance: allowance + carried-over, minus approved and pending, as whole days plus a possible half day. Remaining is rounded down to whole days on the report.",
  inputSchema: { employee: str("employee", MAX_NAME).describe("Employee id or name") },
}, async (a: { employee: string }) => {
  try {
    const { employees, requests } = loadAll();
    const emp = loadEmployee(employees, a.employee);
    const mine = requests.filter((r) => r.employeeId === emp.id);
    const b = balance(emp, mine);
    const summary = mine
      .filter((r) => r.status === "approved" || r.status === "pending")
      .sort((x, z) => x.start.localeCompare(z.start)).map((r) => {
        const days = chargeHalves(r) / 2;
        return `${r.id} ${r.status} ${r.type} ${r.start}..${r.end}${r.halfDay ? " (half)" : ""} = ${days} day${days === 1 ? "" : "s"}`;
      });
    return json({
      employee: emp.name, id: emp.id,
      allowanceDays: b.allowanceDays, carriedOver: b.carriedOver,
      approvedDays: b.approvedDays, pendingDays: b.pendingDays,
      committedDays: b.committedDays, remainingDays: b.remainingDays,
      remainingHalves: b.remainingHalves,
      committedItems: summary,
    });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

function outReport(reqs: LeaveRequest[], employees: Employee[], start: string, end: string) {
  const map = whoIsOut(reqs, start, end, employees);
  const rows = [...map.entries()].map(([date, who]) => ({
    date, out: who.length, names: who.join(", "),
  }));
  const total = rows.reduce((s, r) => s + r.out, 0);
  return { start, end, days: rows.length, personDays: total, calendar: rows };
}

server.registerTool("leave_out_range", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Who is out?",
  description: "Who is out in a date range: start and end are inclusive YYYY-MM-DD. Each employee appears once per day; pending requests count as a plan. Use for coverage, calendars and absence summaries. Free tier: unlimited.",
  inputSchema: {
    start: iso("start").describe("First day, YYYY-MM-DD, inclusive"),
    end: str("end", 32).describe("Last day, YYYY-MM-DD, inclusive").refine((v) => v === undefined || isIsoDate(v), "end must be a real date in YYYY-MM-DD form"),
  },
}, async (a: { start: string; end?: string }) => {
  try {
    const end = a.end ?? a.start;
    endAfterStart(a.start, end);
    const { employees, requests } = loadAll();
    return json(outReport(requests, employees, a.start, end));
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

server.registerTool("leave_list", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  title: "List employees or requests",
  description: "List all employees, or all leave requests (optionally filtered by employee and/or status). Omit the filter to list requests.",
  inputSchema: {
    employee: str("employee", MAX_NAME).optional().describe("Filter requests to one employee"),
    status: z.enum(LEAVE_STATUSES as [string, ...string[]]).optional().describe("Filter requests by status"),
  },
}, async (a: { employee?: string; status?: string }) => {
  try {
    const { employees, requests } = loadAll();
    if (a.status && !LEAVE_STATUSES.includes(a.status as never)) throw new Error(`status must be ${LEAVE_STATUSES.join(", ")}. Nothing was read for it.`);
    if (a.employee || a.status) {
      const emp = a.employee ? findEmployee(employees, a.employee) : null;
      const filtered = requests.filter((r) => (!emp || r.employeeId === emp.id) && (!a.status || r.status === a.status));
      return json({ employees, requests: filtered });
    }
    return json({ employees, requests });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

/* Pro-only additions: bulk CSV import and ICS export. */

function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else if (c === '"') { inQ = true; }
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

server.registerTool("leave_import", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Bulk import requests (Pro)",
  description: "Pro. Bulk-create leave requests from a CSV/TSV. First row is a header: employee,type,start,end,halfDay,status,reason. status may be omitted (defaults to pending) or be approved/rejected. Each request is still checked for overlap conflicts; a conflicting row is reported, not applied. watermark-free, full CRUD.",
  inputSchema: {
    csv: str("csv", 200000).describe("CSV text, newline-separated, first row header: employee,type,start,end,halfDay,status,reason"),
  },
}, async (a: { csv: string }) => {
  try {
    requirePro("Bulk request import", "leave_import");
    const rawRows = a.csv.trim().split(/\r?\n/);
    const header = parseCsvRow(rawRows[0]).map((h) => h.toLowerCase());
    const NEEDED = ["employee", "type", "start", "end"];
    for (const need of NEEDED) {
      if (!header.includes(need)) throw new Error(`header missing column "${need}". Columns: ${header.join(", ")}`);
    }
    const idx = (name: string) => header.indexOf(name);
    const { employees, requests } = loadAll();
    const applied: LeaveRequest[] = [];
    const rejected: string[] = [];
    for (let i = 1; i < rawRows.length; i++) {
      const line = rawRows[i].trim();
      if (!line) continue;
      const cells = parseCsvRow(line);
      if (cells.length < header.length) continue;
      const get = (name: string): string => cells[idx(name)] ?? "";
      try {
        const emp = loadEmployee(employees, get("employee"));
        const type = get("type").toLowerCase();
        if (!LEAVE_TYPES.includes(type as never)) throw new Error(`row ${i + 1}: bad type "${type}"`);
        const start = get("start");
        const end = get("end");
        endAfterStart(start, end);
        const halfDay = /^(1|true|yes)$/i.test(get("halfDay"));
        const statusRaw = get("status").toLowerCase();
        const status = statusRaw === "" ? "pending" : statusRaw;
        if (!LEAVE_STATUSES.includes(status as never)) throw new Error(`row ${i + 1}: bad status "${statusRaw}"`);
        const cand: LeaveRequest = {
          id: "", employeeId: emp.id, type: type as LeaveType, start, end, halfDay, status: status as LeaveRequest["status"],
          reason: get("reason")?.trim() || undefined,
        };
        assertNoConflict([...requests, ...applied], cand);
        cand.id = nextRequestId(requests.concat(applied).map((r) => r.id));
        applied.push(cand);
      } catch (e) { rejected.push(`${i + 1}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    saveAll(employees, [...requests, ...applied]);
    return json({ applied: applied.length, imported: applied.map((r) => r.id), rejected, note: "Watermark-free. Conflicts are refused row by row." });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

server.registerTool("leave_export_ics", { annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  title: "Export calendar (Pro)",
  description: "Pro. Export all APPROVED leave as an .ics calendar (RFC5545). Returns the calendar text; pass path to also write it to a local file. watermark-free.",
  inputSchema: { path: str("path", 500).optional().describe("Local .ics file to write") },
}, async (a: { path?: string }) => {
  try {
    requirePro("Calendar export", "leave_export_ics");
    const { employees, requests } = loadAll();
    const ics = buildIcs(requests, employees);
    let written = null;
    if (a.path) {
      const p = a.path.startsWith("~") ? join(homedir(), a.path.slice(1)) : isAbsolute(a.path) ? a.path : resolvePath(process.cwd(), a.path);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, ics);
      written = p;
    }
    return json({ format: "text/calendar", events: requests.filter((r) => r.status === "approved").length, written, calendar: ics });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

gate.registerTools(server);

server.registerTool("leave_cancel", { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  title: "Cancel leave",
  description: "Cancel a pending or approved request by id, keeping its record with status cancelled. Differs from leave_reject in intent (voluntary withdrawal). Nothing happened if already cancelled.",
  inputSchema: { request: reqRef, reason: str("reason", MAX_REASON).optional().describe("Why") },
}, async (a: { request: string; reason?: string }) => {
  try {
    return locked(() => {
      const { employees, requests } = loadAll();
      const req = findRequest(requests, a.request);
      if (req.status === "cancelled") return json({ id: req.id, status: req.status, note: "already cancelled" });
      const next = requests.map((r) => r.id === req.id ? { ...req, status: "cancelled" as const } : r);
      saveAll(employees, next);
      return json({ id: req.id, status: "cancelled", note: a.reason || null });
    });
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
});

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`mcp-leave ${VERSION} ready; store at ${join(homedir(), ".mcp-leave")}\n`);