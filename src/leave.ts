/**
 * The leave (PTO) domain: employees, leave requests and their balance arithmetic.
 *
 * Everything here is pure (no file I/O, no MCP). The store accessors and the MCP tool
 * shell live in `store.ts` and `index.ts`; what is exported here is the types, the
 * integer balance arithmetic, the working-day count, the who-is-out overlap query and the
 * conflict detection, so the test suite can hit every rule without a transport.
 *
 * DAYS ARE ALWAYS INTEGERS. A request spans `start`..`end` inclusive and a half-day flag
 * subtracts half a day from the charge; the daily charge is 1 for a full day and 0.5 for a
 * half day, but to keep "no floating point" literally true every balance is stored as an
 * integer number of HALF-DAYS (`charge * 2`), and the public balance is reported as
 * `floor(halves / 2)` whole days plus 0 or 0.5 remainder. Nothing here ever produces a
 * binary float during arithmetic.
 */

export type LeaveType = "vacation" | "sick" | "unpaid" | "parental";
export type LeaveStatus = "pending" | "approved" | "rejected" | "cancelled";

export const LEAVE_TYPES: LeaveType[] = ["vacation", "sick", "unpaid", "parental"];
export const LEAVE_STATUSES: LeaveStatus[] = ["pending", "approved", "rejected", "cancelled"];

export interface Employee {
  id: string;
  name: string;
  /** Annual paid leave allowance in whole days, e.g. 25. */
  annualAllowance: number;
  /** Days carried over from the previous year (integer, may be 0). */
  carriedOver: number;
}

export interface LeaveRequest {
  id: string;
  employeeId: string;
  type: LeaveType;
  /** Inclusive start date, YYYY-MM-DD. */
  start: string;
  /** Inclusive end date, YYYY-MM-DD. */
  end: string;
  /** Half-day flag: charges 0.5 for the whole span, not per-day. */
  halfDay: boolean;
  status: LeaveStatus;
  reason?: string;
}

export const MAX_NAME = 200;
export const MAX_REASON = 2000;
export const MAX_ALLOWANCE = 1000;

/** Inclusive day count between two ISO dates (integer, no float). */
export function daySpan(start: string, end: string): number {
  const a = Date.parse(`${start}T00:00:00Z`);
  const b = Date.parse(`${end}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || a > b) {
    throw new Error(`a leave span needs a real end on or after its start; got ${start}..${end}. Nothing was written.`);
  }
  return Math.floor((b - a) / 86400000) + 1;
}

/** The charge of a request, in HALF-DAYS, as an integer. Full day span = span*2, half day = span. */
export function chargeHalves(req: Pick<LeaveRequest, "start" | "end" | "halfDay">): number {
  return daySpan(req.start, req.end) * (req.halfDay ? 1 : 2);
}

/** An approved+pending balance in half-days. */
export function committedHalves(reqs: LeaveRequest[]): number {
  return reqs
    .filter((r) => r.status === "approved" || r.status === "pending")
    .reduce((sum, r) => sum + chargeHalves(r), 0);
}

export interface Balance {
  /** Whole annual allowance days. */
  allowanceDays: number;
  /** Carried-over days. */
  carriedOver: number;
  /** Approved leave in whole days. */
  approvedDays: number;
  /** Pending leave in whole days. */
  pendingDays: number;
  /** Committed (approved + pending) in whole days. */
  committedDays: number;
  /** Remaining; allowance + carried - (approved + pending), rounded down to whole days. */
  remainingDays: number;
  committedHalves: number;
  remainingHalves: number;
}

/** Compute an employee's balance from their allowance and every leave request they own. */
export function balance(emp: Pick<Employee, "annualAllowance" | "carriedOver">, reqs: LeaveRequest[]): Balance {
  const halves = committedHalves(reqs);
  const committedDays = Math.floor(halves / 2);
  const approved = Math.floor(halves / 2); // committed only counts approved+pending; split below
  const approvedHalves = reqs.filter((r) => r.status === "approved").reduce((s, r) => s + chargeHalves(r), 0);
  const pendingHalves = reqs.filter((r) => r.status === "pending").reduce((s, r) => s + chargeHalves(r), 0);
  const total = (emp.annualAllowance + emp.carriedOver) * 2; // half-days available
  const remainingHalves = total - halves;
  return {
    allowanceDays: emp.annualAllowance,
    carriedOver: emp.carriedOver,
    approvedDays: Math.floor(approvedHalves / 2),
    pendingDays: Math.floor(pendingHalves / 2),
    committedDays,
    remainingDays: Math.floor(remainingHalves / 2),
    committedHalves: halves,
    remainingHalves,
  };
}

export interface OutDay {
  date: string;
  /** Comma-joined list of employee names out that day. */
  who: string[];
}

/** The number of whole days two spans overlap (0 if none). Integer. */
export function overlapDays(aStart: string, aEnd: string, bStart: string, bEnd: string): number {
  const s = aStart > bStart ? aStart : bStart;
  const e = aEnd < bEnd ? aEnd : bEnd;
  if (s > e) return 0;
  return daySpan(s, e);
}

/**
 * Overlapping leave for one employee: any two non-cancelled, non-rejected requests of the
 * same employee that share a calendar day. Returns the conflicting pair and the shared
 * dates. Used both to refuse new conflicting requests and to surface existing overlaps.
 */
export function findConflicts(reqs: LeaveRequest[]): { a: LeaveRequest; b: LeaveRequest; days: number }[] {
  const active = reqs.filter((r) => r.status === "approved" || r.status === "pending");
  const out: { a: LeaveRequest; b: LeaveRequest; days: number }[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const x = active[i];
      const y = active[j];
      if (x.employeeId === y.employeeId) {
        const d = overlapDays(x.start, x.end, y.start, y.end);
        if (d > 0) out.push({ a: x, b: y, days: d });
      }
    }
  }
  return out;
}

/**
 * Who is out on each day inside [start, end]? Considers approved AND pending requests
 * (a pending who-is-out is still a plan), one employee appears at most once per day.
 * Returns a map keyed by ISO date.
 */
export function whoIsOut(reqs: LeaveRequest[], start: string, end: string, employees: Employee[]): Map<string, string[]> {
  const byEmp = new Map<Employee["id"], Employee>();
  for (const e of employees) byEmp.set(e.id, e);
  const out = new Map<string, string[]>();
  const active = reqs.filter((r) => r.status === "approved" || r.status === "pending");
  const first = Date.parse(`${start}T00:00:00Z`);
  const last = Date.parse(`${end}T00:00:00Z`);
  for (let t = first; t <= last; t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const names: string[] = [];
    for (const r of active) {
      if (date >= r.start && date <= r.end) {
        const emp = byEmp.get(r.employeeId);
        if (emp && !names.includes(emp.name)) names.push(emp.name);
      }
    }
    names.sort();
    if (names.length) out.set(date, names);
  }
  return out;
}