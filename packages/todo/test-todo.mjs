// End-to-end test for the batch `operations[]` todo tool.
//
// Loads the built extension, mocks ExtensionAPI, drives the tool's
// `execute` directly with crafted batch operations, and asserts on the
// human-readable summary, the structured `details` envelope, and the
// all-or-nothing atomicity contract.
//
// Run from packages/todo/: `node test-todo.mjs`
//   (or from anywhere:  `node packages/todo/test-todo.mjs`)
//
// Not in `files`; never published. Exits non-zero on any failure.

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = pathToFileURL(path.join(here, "dist", "index.mjs")).href;

const { default: extension } = await import(dist);

// ---------------------------------------------------------------------------
// Mock ExtensionAPI
// ---------------------------------------------------------------------------

let tool = null;
const events = {};
const pi = {
  registerTool: (t) => {
    if (tool) throw new Error("test bug: tool registered twice");
    tool = t;
  },
  registerCommand: () => {},
  registerShortcut: () => {},
  on: (event, fn) => {
    events[event] = fn;
  },
};

extension(pi);

if (!tool) throw new Error("extension did not call pi.registerTool");
console.log(`tool registered: name=${tool.name}  label=${tool.label}`);

// ---------------------------------------------------------------------------
// Mock ExtensionContext (per-sid so the reducer's in-memory store is shared)
// ---------------------------------------------------------------------------

let activeSid = "test-session-A";
const ctx = {
  sessionManager: { getSessionId: () => activeSid },
  hasUI: false,
};

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ✓ ${label}`);
    pass++;
    return;
  }
  console.error(`  ✗ ${label}\n      expected: ${e}\n      actual:   ${a}`);
  fail++;
}
function ok(cond, label, detail) {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
    return;
  }
  console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  fail++;
}
async function call(operations) {
  return tool.execute("call-1", { operations }, undefined, undefined, ctx);
}
async function listCount() {
  const r = await call([{ op: "list" }]);
  return r.details.tasks.filter((t) => t.status !== "deleted").length;
}
async function fullList() {
  const r = await call([{ op: "list", includeDeleted: true }]);
  return r.details.tasks;
}

// ---------------------------------------------------------------------------
// Scenario 1: create 3 tasks in one batch
// ---------------------------------------------------------------------------

console.log("\n[1] create 3 tasks in one batch");
{
  const r = await call([
    { op: "create", subject: "alpha" },
    { op: "create", subject: "beta", activeForm: "B-ing" },
    { op: "create", subject: "gamma", description: "the third one" },
  ]);
  eq(r.content[0].text, "created #1, #2, #3", "summary");
  eq(r.details.operations, 3, "details.operations is the count");
  eq(r.details.tasks.length, 3, "details.tasks length");
  eq(
    r.details.tasks.map((t) => t.subject),
    ["alpha", "beta", "gamma"],
    "subjects in insertion order",
  );
  eq(r.details.tasks[1].activeForm, "B-ing", "activeForm preserved");
  eq(r.details.tasks[2].description, "the third one", "description preserved");
  eq(r.details.tasks[0].status, "pending", "new task starts pending");
  eq(r.details.nextId, 4, "nextId advanced");
}

// ---------------------------------------------------------------------------
// Scenario 2: cross-reference — later op references earlier-created id
// ---------------------------------------------------------------------------

console.log("\n[2] later op references earlier-created id (addBlockedBy)");
{
  const r = await call([
    { op: "create", subject: "needs-alpha" }, // #4
    { op: "update", id: 4, addBlockedBy: [1] }, // depends on alpha
  ]);
  eq(r.content[0].text, "created #4; updated #4", "summary");
  const updated = r.details.tasks.find((t) => t.id === 4);
  eq(updated.blockedBy, [1], "blockedBy set on #4");
  eq(r.details.nextId, 5, "nextId advanced once (create only)");
}

// ---------------------------------------------------------------------------
// Scenario 3: forward reference fails the whole batch, state unchanged
// ---------------------------------------------------------------------------

console.log("\n[3] forward reference fails whole batch, prior list unchanged");
{
  const before = await fullList();
  const beforeActive = await listCount();
  let caught = null;
  try {
    await call([
      { op: "create", subject: "would-succeed" },
      { op: "update", id: 999, subject: "would-fail" },
    ]);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error, "threw an Error");
  ok(
    /update.*999|999.*update/.test(caught?.message ?? ""),
    "error message names the verb and the missing id",
    `got: ${caught?.message}`,
  );
  ok(/op #2/.test(caught?.message ?? ""), "error is 1-based (op #2)", `got: ${caught?.message}`);
  const after = await fullList();
  const afterActive = await listCount();
  eq(after.length, before.length, "details.tasks length unchanged");
  eq(afterActive, beforeActive, "active (non-deleted) count unchanged");
}

// ---------------------------------------------------------------------------
// Scenario 4: get returns the full task
// ---------------------------------------------------------------------------

console.log("\n[4] get op returns the full task in details");
{
  const r = await call([{ op: "get", id: 1 }]);
  eq(r.content[0].text, "got #1", "summary");
  eq(r.details.operations, 1, "operations count = 1");
  const t = r.details.tasks.find((x) => x.id === 1);
  eq(t.subject, "alpha", "subject retrieved");
  eq(t.status, "pending", "status retrieved");
}

// ---------------------------------------------------------------------------
// Scenario 5: get to a missing id fails the whole batch
// ---------------------------------------------------------------------------

console.log("\n[5] get to a missing id fails the whole batch");
{
  const before = await listCount();
  let caught = null;
  try {
    await call([
      { op: "create", subject: "wins-batch-credit" }, // would succeed
      { op: "get", id: 99 }, // would fail
    ]);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error, "threw");
  ok(
    /get.*99|99.*get/.test(caught?.message ?? ""),
    "error names verb and id",
    `got: ${caught?.message}`,
  );
  // The create should NOT have been committed (atomicity)
  const after = await listCount();
  eq(after, before, "active count unchanged (create was rolled back)");
}

// ---------------------------------------------------------------------------
// Scenario 6: list op summary
// ---------------------------------------------------------------------------

console.log("\n[6] list op summary");
{
  const r = await call([{ op: "list" }]);
  ok(
    /^listed \d+ tasks?$/.test(r.content[0].text),
    `summary matches /listed N tasks?/: got "${r.content[0].text}"`,
  );
  const visible = r.details.tasks.filter((t) => t.status !== "deleted");
  ok(
    r.content[0].text === `listed ${visible.length} task${visible.length === 1 ? "" : "s"}`,
    "summary count matches active tasks",
  );
}

// ---------------------------------------------------------------------------
// Scenario 7: delete tombstones the task
// ---------------------------------------------------------------------------

console.log("\n[7] delete op tombstones the task");
{
  const r = await call([{ op: "delete", id: 2 }]);
  eq(r.content[0].text, "deleted #2", "summary");
  // Task still in details.tasks but status=deleted
  const t = r.details.tasks.find((x) => x.id === 2);
  eq(t.status, "deleted", "task tombstoned (status=deleted)");
  // It should NOT appear in an active-only list
  const visible = r.details.tasks.filter((x) => x.status !== "deleted");
  ok(
    visible.every((x) => x.id !== 2),
    "deleted task excluded from active list",
  );
  // Re-creating a task should NOT reuse id 2
  const r2 = await call([{ op: "create", subject: "after-delete" }]);
  const created = r2.details.tasks[r2.details.tasks.length - 1];
  ok(created.id > 2, "next id is monotonic across deletes");
}

// ---------------------------------------------------------------------------
// Scenario 8: update to nonexistent id fails atomically
// ---------------------------------------------------------------------------

console.log("\n[8] update to nonexistent id fails atomically");
{
  const before = await listCount();
  let caught = null;
  try {
    await call([
      { op: "create", subject: "would-also-succeed" },
      { op: "update", id: 4242, status: "completed" },
    ]);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error, "threw");
  const after = await listCount();
  eq(after, before, "active count unchanged (create rolled back)");
}

// ---------------------------------------------------------------------------
// Scenario 9: create with empty subject fails
// ---------------------------------------------------------------------------

console.log("\n[9] create with empty/whitespace subject fails");
{
  let caught = null;
  try {
    await call([{ op: "create", subject: "   " }]);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error, "threw on whitespace-only subject");
  ok(
    /subject is empty/.test(caught?.message ?? ""),
    `error mentions empty subject: ${caught?.message}`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 10: blockedBy to a non-existent id fails the whole batch
// ---------------------------------------------------------------------------

console.log("\n[10] blockedBy referencing a nonexistent id fails whole batch");
{
  const before = await listCount();
  let caught = null;
  try {
    await call([{ op: "create", subject: "x", blockedBy: [1234] }]);
  } catch (e) {
    caught = e;
  }
  ok(caught instanceof Error, "threw");
  ok(
    /blockedBy.*1234|1234.*blockedBy/.test(caught?.message ?? ""),
    `error names blockedBy and id: ${caught?.message}`,
  );
  const after = await listCount();
  eq(after, before, "active count unchanged");
}

// ---------------------------------------------------------------------------
// Scenario 11: clear empties the list (preserving nextId)
// ---------------------------------------------------------------------------

console.log("\n[11] clear op empties the list but preserves nextId");
{
  // Snapshot nextId before clear
  const before = await fullList();
  const beforeNextId = (await call([{ op: "list" }])).details.nextId;
  const r = await call([{ op: "clear" }]);
  ok(/^cleared \(\d+ removed\)$/.test(r.content[0].text), `summary: ${r.content[0].text}`);
  const removedMatch = r.content[0].text.match(/cleared \((\d+) removed\)/);
  const removed = removedMatch ? Number(removedMatch[1]) : -1;
  eq(removed, before.length, "removed count matches all tasks (incl. deleted)");
  eq(r.details.tasks.length, 0, "details.tasks empty after clear");
  eq(r.details.nextId, beforeNextId, "nextId preserved across clear");
  // Next create should NOT restart from id=1
  const r2 = await call([{ op: "create", subject: "post-clear" }]);
  const created = r2.details.tasks[0];
  ok(created.id === beforeNextId, `new task gets id=${beforeNextId}, got ${created.id}`);
}

// ---------------------------------------------------------------------------
// Scenario 12: details envelope shape (for /reload branch replay)
// ---------------------------------------------------------------------------

console.log("\n[12] details envelope shape");
{
  // Use a fresh sid so the state is empty (scenario 11 cleared the prior list).
  activeSid = "test-session-B";
  // First call: create two tasks so we know the minted ids.
  const seed = await call([
    { op: "create", subject: "seed-1" },
    { op: "create", subject: "seed-2" },
  ]);
  const seedIds = seed.details.tasks.map((t) => t.id);
  const id1 = seedIds[0];
  // Now drive a mixed batch using those ids.
  const r = await call([
    { op: "create", subject: "d1" },
    { op: "create", subject: "d2" },
    { op: "update", id: id1, status: "in_progress" },
    { op: "get", id: id1 },
    { op: "list" },
  ]);
  eq(r.details.operations, 5, "details.operations is the count (not the ops array)");
  ok(Array.isArray(r.details.tasks), "details.tasks is an array");
  ok(typeof r.details.nextId === "number", "details.nextId is a number");
  // The Task shape is intact
  const sample = r.details.tasks[0];
  ok(typeof sample.id === "number", "task has numeric id");
  ok(typeof sample.subject === "string", "task has string subject");
  ok(
    ["pending", "in_progress", "completed", "deleted"].includes(sample.status),
    "task status is a valid enum",
  );
}

// ---------------------------------------------------------------------------
// Scenario 13: empty operations array is rejected by the schema
// ---------------------------------------------------------------------------

console.log("\n[13] empty operations array is rejected by schema (minItems: 1)");
{
  // Schema validation happens before execute; in a real pi run the model
  // would never get an empty array past the tool's parameter validator.
  // We just confirm the schema declares the constraint.
  const params = tool.parameters;
  const opsField = params?.properties?.operations;
  ok(opsField?.minItems === 1, `operations.minItems === 1, got ${opsField?.minItems}`);
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
