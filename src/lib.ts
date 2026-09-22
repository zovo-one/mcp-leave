/**
 * The leave engine, as a stable public API for other servers in this repo.
 *
 * `src/index.ts` is the MCP server (tools, licensing, tool copy). What is re-exported here
 * is the domain types and the pure balance / conflict / who-is-out arithmetic, so a sibling
 * server can read the same store and reuse the balance rule without a second copy.
 *
 * Nothing here touches the network, the filesystem or the licence store at import time.
 *
 * Stability: the names below are the contract. `@theluckystrike/mcp-leave/dist/*.js`
 * deep imports are not.
 */

export type {
  Balance, Employee, LeaveRequest, LeaveStatus, LeaveType,
} from "./leave.js";
export {
  LEAVE_STATUSES, LEAVE_TYPES, MAX_ALLOWANCE, MAX_NAME, MAX_REASON,
  balance, chargeHalves, committedHalves, daySpan, findConflicts, overlapDays, whoIsOut,
} from "./leave.js";

export {
  findEmployee, findRequest, getEmployees, getRequests, lockPath,
  nextEmployeeId, nextRequestId, setEmployees, setRequests, storeDir, storePath,
} from "./store.js";