/**
 * pi-todo — a multi-item todo extension for Pi, modeled on the community
 * rpiv-todo extension (Pi has no built-in todo tool).
 *
 * Exposes a `todo` tool with six actions — create, update, list, get,
 * delete, clear — plus a `/todos` slash command that prints the live list
 * grouped by status. Tasks carry a 4-state status machine
 * (pending -> in_progress -> completed, plus a `deleted` tombstone),
 * optional `blockedBy` dependencies, an `activeForm` spinner label, an
 * `owner`, and free-form `metadata`.
 *
 * Tasks survive `/reload` by branch replay: every `todo` tool result echoes
 * the full list under `details`, and `session_start` rebuilds state from the
 * last such entry in the session branch (the transcript Pi persists). No
 * separate on-disk file. The overlay uses Pi's `setWidget` component-factory
 * form: it reads live state at render time, themes via `Theme`, refreshes in
 * place via `tui.requestRender()`, and collapses/expands on `ctrl+shift+t`.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { KeyId, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

interface TaskState {
  tasks: Task[];
  nextId: number;
}

// ---------------------------------------------------------------------------
// Tool / command identity
// ---------------------------------------------------------------------------

const TOOL_NAME = "todo";
const TOOL_LABEL = "Todo";
const COMMAND_NAME = "todos";
const MSG_NO_TODOS = "No todos yet. Ask the agent to add some!";

// ---------------------------------------------------------------------------
// Parameter schema (every description doubles as LLM-facing prompt copy)
// ---------------------------------------------------------------------------

const StatusEnum = Type.Union(
  [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
  { description: "Task status" },
);

const TaskMetadata = Type.Record(Type.String(), Type.Unknown());

const CreateOp = Type.Object({
  op: Type.Literal("create"),
  subject: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()),
  blockedBy: Type.Optional(Type.Array(Type.Integer())),
  owner: Type.Optional(Type.String()),
  metadata: Type.Optional(TaskMetadata),
});

const UpdateOp = Type.Object({
  op: Type.Literal("update"),
  id: Type.Integer(),
  subject: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  activeForm: Type.Optional(Type.String()),
  status: Type.Optional(StatusEnum),
  blockedBy: Type.Optional(Type.Array(Type.Integer())),
  addBlockedBy: Type.Optional(Type.Array(Type.Integer())),
  removeBlockedBy: Type.Optional(Type.Array(Type.Integer())),
  owner: Type.Optional(Type.String()),
  metadata: Type.Optional(TaskMetadata),
});

const DeleteOp = Type.Object({
  op: Type.Literal("delete"),
  id: Type.Integer(),
});

const ClearOp = Type.Object({
  op: Type.Literal("clear"),
});

const GetOp = Type.Object({
  op: Type.Literal("get"),
  id: Type.Integer(),
});

const ListOp = Type.Object({
  op: Type.Literal("list"),
  includeDeleted: Type.Optional(Type.Boolean()),
});

const TodoOperation = Type.Union([CreateOp, UpdateOp, DeleteOp, ClearOp, GetOp, ListOp]);

const TodoParams = Type.Object({
  operations: Type.Array(TodoOperation, { minItems: 1 }),
});
type TodoParams = Static<typeof TodoParams>;
type TodoOperation = Static<typeof TodoOperation>;
type CreateOp = Static<typeof CreateOp>;
type UpdateOp = Static<typeof UpdateOp>;
type DeleteOp = Static<typeof DeleteOp>;
type ClearOp = Static<typeof ClearOp>;
type GetOp = Static<typeof GetOp>;
type ListOp = Static<typeof ListOp>;

type Receipt =
  | { op: "create"; id: number }
  | { op: "update"; id: number }
  | { op: "delete"; id: number }
  | { op: "clear"; removed: number }
  | { op: "get"; id: number; task: Task }
  | { op: "list"; count: number; ids: number[] };

// ---------------------------------------------------------------------------
// Guidance surfaced to the model (parity with the upstream rpiv-todo extension)
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
const DEFAULT_PROMPT_GUIDELINES: string[] = [
  "Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
  "Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array).",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
  "Use the `operations[]` field to batch multiple task changes in one call — creates, updates, deletes, clears, gets, and lists can be combined in a single batch. The batch is all-or-nothing: a bad reference (missing id, empty subject) fails the whole call and commits nothing.",
  "When batching, create prerequisite tasks before dependent ones. Within one batch, later ops can reference ids minted by earlier creates via `blockedBy` / `addBlockedBy` / `update.id` / `delete.id` / `get.id`. The reducer threads state across ops, so an id is referenceable as soon as its create lands.",
];

// ---------------------------------------------------------------------------
// Store: per-session in-memory state, reconstructed from each session's branch
// on /reload via `replayFromBranch`. The branch (the conversation transcript Pi
// persists) is the source of truth — each `todo` tool result echoes the full
// task snapshot under `details`, so the last one reconstructs that session's
// list. Keyed by session id so child/forked sessions keep separate lists; only
// the foreground session binds and refreshes the shared overlay. No on-disk
// file.
// ---------------------------------------------------------------------------

const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/** Discriminator for `details` envelopes matching the persisted TaskDetails shape. */
function isTaskDetails(value: unknown): value is { tasks: Task[]; nextId: number } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Walk the current branch in chronological order; the LAST `toolResult` whose
 * `toolName === TOOL_NAME` and whose `details` shape matches `TaskDetails` wins
 * (last-write-wins). Returns EMPTY_STATE when no matching entry exists.
 */
function replayFromBranch(ctx: ExtensionContext): TaskState {
  let result: TaskState = { tasks: [], nextId: EMPTY_STATE.nextId };
  for (const entry of ctx.sessionManager.getBranch()) {
    const e = entry as {
      type?: string;
      message?: { role?: string; toolName?: string; details?: unknown };
    };
    if (e.type !== "message") continue;
    const msg = e.message;
    if (msg?.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
    if (!isTaskDetails(msg.details)) continue;
    result = {
      tasks: msg.details.tasks.map((t) => ({ ...t })),
      nextId: msg.details.nextId,
    };
  }
  return result;
}

// Per-session store. Each session replays into its own slot (sid-gated) so a
// forked/child session can never read or clobber another session's tasks.
const sessions = new Map<string, TaskState>();
// Ctx-less render pointer: which slot does the overlay render? Set once by the
// first UI-bearing session_start (foreground claim).
let activeRenderSession = "";

function sid(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() ?? "";
}

function getState(sessionId: string): TaskState {
  return sessions.get(sessionId) ?? { tasks: [], nextId: EMPTY_STATE.nextId };
}

function commitState(sessionId: string, next: TaskState): void {
  sessions.set(sessionId, next);
}

function replaceState(sessionId: string, next: TaskState): void {
  sessions.set(sessionId, next);
}

function evictSession(sessionId: string): void {
  sessions.delete(sessionId);
}

function getRenderState(): TaskState {
  return sessions.get(activeRenderSession) ?? { tasks: [], nextId: EMPTY_STATE.nextId };
}

function setActiveRenderSession(sessionId: string): void {
  activeRenderSession = sessionId;
}

function getActiveRenderSession(): string {
  return activeRenderSession;
}

function clearActiveRenderSession(): void {
  activeRenderSession = "";
}

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

function unique(nums: number[]): number[] {
  return [...new Set(nums)];
}

function mergeMetadata(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existing ?? {}) };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// Reference-existence guards. Both throw the same friendly-error template
// the old switch cases used; the difference is the verb and the
// `references blockedBy` vs `is 'verb'` lead-in. `assertAndGetTask` also
// returns the (non-deleted) task so callers can use it without a second
// `state.tasks.find` lookup.
function assertAndGetTask(state: TaskState, ordinal: number, id: number, verb: string): Task {
  const task = state.tasks.find((t) => t.id === id && t.status !== "deleted");
  if (!task) {
    throw new Error(`op #${ordinal} is '${verb}' but no task ${id} exists`);
  }
  return task;
}

function assertBlockedByRef(state: TaskState, ordinal: number, id: number): void {
  if (state.tasks.some((t) => t.id === id && t.status !== "deleted")) return;
  throw new Error(`op #${ordinal} references blockedBy [${id}] but no task ${id} exists`);
}

// Per-op application — each takes the corresponding per-op Static type as
// its parameter type (so the `CreateOp` / `UpdateOp` / `DeleteOp` /
// `ClearOp` / `GetOp` / `ListOp` aliases are referenced and biome stops
// flagging them as unused). Each is a direct port of the matching case in
// the old `applyTaskMutation` switch.
function applyCreate(
  state: TaskState,
  op: CreateOp,
  ordinal: number,
): { state: TaskState; receipt: Receipt } {
  if (op.subject.trim() === "") {
    throw new Error(`op #${ordinal} is 'create' but subject is empty`);
  }
  if (op.blockedBy) {
    for (const bid of op.blockedBy) assertBlockedByRef(state, ordinal, bid);
  }
  const id = state.nextId;
  const task: Task = {
    id,
    subject: op.subject,
    description: op.description,
    activeForm: op.activeForm,
    status: "pending",
    blockedBy: op.blockedBy ? unique(op.blockedBy) : undefined,
    owner: op.owner,
    metadata: op.metadata ? mergeMetadata(undefined, op.metadata) : undefined,
  };
  return {
    state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 },
    receipt: { op: "create", id },
  };
}

function applyUpdate(
  state: TaskState,
  op: UpdateOp,
  ordinal: number,
): { state: TaskState; receipt: Receipt } {
  const task = assertAndGetTask(state, ordinal, op.id, "update");
  if (op.blockedBy) {
    for (const bid of op.blockedBy) assertBlockedByRef(state, ordinal, bid);
  }
  if (op.addBlockedBy) {
    for (const bid of op.addBlockedBy) assertBlockedByRef(state, ordinal, bid);
  }
  const updated: Task = { ...task };
  if (op.subject !== undefined) updated.subject = op.subject;
  if (op.description !== undefined) updated.description = op.description;
  if (op.activeForm !== undefined) updated.activeForm = op.activeForm;
  if (op.owner !== undefined) updated.owner = op.owner;
  if (op.status !== undefined) updated.status = op.status;
  if (op.blockedBy !== undefined) updated.blockedBy = op.blockedBy;
  if (op.addBlockedBy?.length) {
    updated.blockedBy = unique([...(updated.blockedBy ?? []), ...op.addBlockedBy]);
  }
  if (op.removeBlockedBy?.length) {
    const remove = op.removeBlockedBy;
    updated.blockedBy = (updated.blockedBy ?? []).filter((b) => !remove.includes(b));
  }
  if (op.metadata !== undefined) {
    updated.metadata = mergeMetadata(task.metadata, op.metadata);
  }
  return {
    state: {
      ...state,
      tasks: state.tasks.map((t) => (t.id === op.id && t.status !== "deleted" ? updated : t)),
    },
    receipt: { op: "update", id: op.id },
  };
}

function applyDelete(
  state: TaskState,
  op: DeleteOp,
  ordinal: number,
): { state: TaskState; receipt: Receipt } {
  assertAndGetTask(state, ordinal, op.id, "delete");
  return {
    state: {
      ...state,
      tasks: state.tasks.map((t) =>
        t.id === op.id && t.status !== "deleted" ? { ...t, status: "deleted" as const } : t,
      ),
    },
    receipt: { op: "delete", id: op.id },
  };
}

function applyClear(
  state: TaskState,
  _op: ClearOp,
  _ordinal: number,
): { state: TaskState; receipt: Receipt } {
  const removed = state.tasks.length;
  return {
    state: { tasks: [], nextId: state.nextId },
    receipt: { op: "clear", removed },
  };
}

function applyGet(
  state: TaskState,
  op: GetOp,
  ordinal: number,
): { state: TaskState; receipt: Receipt } {
  const task = assertAndGetTask(state, ordinal, op.id, "get");
  return {
    state,
    receipt: { op: "get", id: op.id, task },
  };
}

function applyList(
  state: TaskState,
  op: ListOp,
  _ordinal: number,
): { state: TaskState; receipt: Receipt } {
  const visible = listTasks(state, op.includeDeleted ?? false);
  return {
    state,
    receipt: { op: "list", count: visible.length, ids: visible.map((t) => t.id) },
  };
}

// Dispatcher — exhaustive switch on op.op, hands the (fully-typed) op to
// the matching per-op helper. The `never` guard catches a future op added
// to the union but not handled here.
function applyOneOp(
  state: TaskState,
  op: TodoOperation,
  ordinal: number,
): { state: TaskState; receipt: Receipt } {
  switch (op.op) {
    case "create":
      return applyCreate(state, op, ordinal);
    case "update":
      return applyUpdate(state, op, ordinal);
    case "delete":
      return applyDelete(state, op, ordinal);
    case "clear":
      return applyClear(state, op, ordinal);
    case "get":
      return applyGet(state, op, ordinal);
    case "list":
      return applyList(state, op, ordinal);
    default: {
      const _exhaustive: never = op;
      throw new Error(`unreachable: ${String(_exhaustive)}`);
    }
  }
}

function applyOperations(
  start: TaskState,
  ops: TodoOperation[],
): { state: TaskState; receipts: Receipt[] } {
  let state = start;
  const receipts: Receipt[] = [];
  for (const [i, op] of ops.entries()) {
    const result = applyOneOp(state, op, i + 1);
    state = result.state;
    receipts.push(result.receipt);
  }
  return { state, receipts };
}

// ---------------------------------------------------------------------------
// Formatting + tool result
// ---------------------------------------------------------------------------

function statusIcon(status: TaskStatus): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "◐";
  return "○";
}

function formatTaskLine(task: Task): string {
  const dep = task.blockedBy?.length ? ` (blocked by ${task.blockedBy.join(", ")})` : "";
  const desc = task.description ? ` — ${task.description}` : "";
  return `${statusIcon(task.status)} #${task.id} ${task.subject}${desc}${dep}`;
}

function listTasks(current: TaskState, includeDeleted: boolean): Task[] {
  return current.tasks.filter((t) => includeDeleted || t.status !== "deleted");
}

// Overlay line budget. The widget (header + task lines + optional overflow
// summary + trailing blank) is capped at MAX_OVERLAY_LINES. Display order is the
// original (insertion) order so in_progress items stay where they were created;
// on overflow we drop the lowest-priority tasks first so pending/in_progress are
// kept and completed tasks drop first.
const MAX_OVERLAY_LINES = 12;

// Priority for KEEPING a task visible on overflow: lower = kept longer. Completed
// tasks drop first; pending and in_progress are kept (truncate last).
const KEEP_PRIORITY: Record<TaskStatus, number> = {
  pending: 0,
  in_progress: 0,
  completed: 1,
  deleted: 2,
};

function selectForOverlay(tasks: Task[], maxLines: number): { shown: Task[]; overflow: number } {
  // Decide which tasks survive overflow by keep-priority (not display order).
  const keepOrdered = [...tasks].sort(
    (a, b) => KEEP_PRIORITY[a.status] - KEEP_PRIORITY[b.status] || a.id - b.id,
  );
  const header = 1;
  const blank = 1;
  const overflowLine = 1;
  if (keepOrdered.length <= maxLines - header - blank) {
    return { shown: tasks, overflow: 0 };
  }
  // Reserve a line for the "+N more" summary.
  const budget = Math.max(0, maxLines - header - blank - overflowLine);
  const keptIds = new Set(keepOrdered.slice(0, budget).map((t) => t.id));
  // Return survivors in original (insertion) order so in_progress stays in place.
  const shown = tasks.filter((t) => keptIds.has(t.id));
  return { shown, overflow: tasks.length - shown.length };
}

function buildToolResult(
  ops: TodoOperation[],
  current: TaskState,
  receipts: Receipt[],
): { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> } {
  const createReceipts: { op: "create"; id: number }[] = [];
  const updateReceipts: { op: "update"; id: number }[] = [];
  const deleteReceipts: { op: "delete"; id: number }[] = [];
  const clearReceipts: { op: "clear"; removed: number }[] = [];
  const getReceipts: { op: "get"; id: number; task: Task }[] = [];
  const listReceipts: { op: "list"; count: number; ids: number[] }[] = [];
  for (const r of receipts) {
    switch (r.op) {
      case "create":
        createReceipts.push(r);
        break;
      case "update":
        updateReceipts.push(r);
        break;
      case "delete":
        deleteReceipts.push(r);
        break;
      case "clear":
        clearReceipts.push(r);
        break;
      case "get":
        getReceipts.push(r);
        break;
      case "list":
        listReceipts.push(r);
        break;
    }
  }
  const segments: string[] = [];
  if (createReceipts.length > 0) {
    segments.push(`created ${createReceipts.map((r) => `#${r.id}`).join(", ")}`);
  }
  if (updateReceipts.length > 0) {
    segments.push(`updated ${updateReceipts.map((r) => `#${r.id}`).join(", ")}`);
  }
  if (deleteReceipts.length > 0) {
    segments.push(`deleted ${deleteReceipts.map((r) => `#${r.id}`).join(", ")}`);
  }
  if (clearReceipts.length > 0) {
    const removed = clearReceipts.reduce((sum, r) => sum + r.removed, 0);
    segments.push(`cleared (${removed} removed)`);
  }
  if (getReceipts.length > 0) {
    segments.push(`got ${getReceipts.map((r) => `#${r.id}`).join(", ")}`);
  }
  if (listReceipts.length > 0) {
    const total = listReceipts.reduce((sum, r) => sum + r.count, 0);
    segments.push(`listed ${total} tasks`);
  }
  const text = segments.length > 0 ? segments.join("; ") : "noop.";
  return {
    content: [{ type: "text", text }],
    details: { operations: ops.length, tasks: current.tasks, nextId: current.nextId },
  };
}

// ---------------------------------------------------------------------------
// Overlay widget (rendered above the editor while tasks exist)
// ---------------------------------------------------------------------------

const OVERLAY_KEY = "pi-todo";
const COLLAPSE_KEY = "ctrl+shift+t";

class TodoOverlay {
  private uiCtx: ExtensionUIContext | undefined;
  private tui: TUI | undefined;
  private registered = false;
  private collapsed = false;

  setUICtx(ctx: ExtensionUIContext): void {
    // Identity-compare so a repeat session_start is idempotent; on identity
    // change (/reload) invalidate so update() re-registers cleanly.
    if (ctx !== this.uiCtx) {
      this.uiCtx = ctx;
      this.registered = false;
      this.tui = undefined;
    }
  }

  update(): void {
    if (!this.uiCtx) return;
    const visible = listTasks(getRenderState(), false);
    if (visible.length === 0) {
      if (this.registered) {
        this.uiCtx.setWidget(OVERLAY_KEY, undefined);
        this.registered = false;
        this.tui = undefined;
      }
      return;
    }
    if (!this.registered) {
      this.uiCtx.setWidget(
        OVERLAY_KEY,
        (tui: TUI, theme: Theme) => {
          this.tui = tui;
          return {
            render: (width: number) => this.renderWidget(theme, width),
            invalidate: () => {
              this.registered = false;
              this.tui = undefined;
            },
          };
        },
        { placement: "aboveEditor" },
      );
      this.registered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.tui?.requestRender(true);
  }

  isRegistered(): boolean {
    return this.registered;
  }

  dispose(): void {
    if (this.uiCtx) this.uiCtx.setWidget(OVERLAY_KEY, undefined);
    this.registered = false;
    this.tui = undefined;
    this.uiCtx = undefined;
    this.collapsed = false;
  }

  private renderWidget(theme: Theme, width: number): string[] {
    const visible = listTasks(getRenderState(), false);
    if (visible.length === 0) return [];
    const total = visible.length;
    const completed = visible.filter((t) => t.status === "completed").length;
    const hasActive = visible.some((t) => t.status !== "completed");
    const headingColor: ThemeColor = hasActive ? "accent" : "dim";
    const headingIcon = hasActive ? "●" : "○";
    const heading = truncateToWidth(
      `${theme.fg(headingColor, headingIcon)} ${theme.fg(headingColor, `Todos (${completed}/${total})`)}`,
      width,
      "…",
    );

    if (this.collapsed) {
      return [heading, theme.fg("dim", `└─ collapsed (${COLLAPSE_KEY} to expand)`), ""];
    }

    // Cap the widget at MAX_OVERLAY_LINES; on overflow drop the lowest-priority
    // tasks first (completed, then in_progress, then pending) and show "+N more".
    const { shown, overflow } = selectForOverlay(visible, MAX_OVERLAY_LINES);

    const lines: string[] = [heading];
    shown.forEach((task, i) => {
      const prefix = i === shown.length - 1 && overflow === 0 ? "└─" : "├─";
      const icon = statusIcon(task.status);
      // in_progress icon is highlighted yellow (ThemeColor "warning" => yellow);
      // completed tick is green (ThemeColor "success" => green).
      const iconText =
        task.status === "in_progress"
          ? theme.fg("warning", icon)
          : task.status === "completed"
            ? theme.fg("success", icon)
            : theme.fg("dim", icon);
      const dep = task.blockedBy?.length ? ` (blocked by ${task.blockedBy.join(", ")})` : "";
      const label = task.description ? `${task.subject} — ${task.description}` : task.subject;
      const text =
        task.status === "completed" ? theme.fg("dim", theme.strikethrough(label)) : label;
      const body = `${iconText} ${text}${dep}`;
      const line = `${theme.fg("dim", prefix)} ${body}`;
      lines.push(truncateToWidth(line, width, "…"));
    });
    if (overflow > 0) {
      lines.push(theme.fg("dim", `└─ +${overflow} more`));
    }
    lines.push("");
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  let todoOverlay: TodoOverlay | undefined;

  // Collapse/expand the overlay. No-op without UI, before registration, or in
  // headless mode.
  pi.registerShortcut(COLLAPSE_KEY as KeyId, {
    description: "Collapse or expand the todo overlay",
    handler: (ctx) => {
      if (!ctx.hasUI || !todoOverlay?.isRegistered()) return;
      todoOverlay?.toggleCollapse();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const id = sid(ctx);
    replaceState(id, replayFromBranch(ctx));
    if (!ctx.hasUI) return;
    // First UI-bearing session_start claims the foreground (the interactive
    // launcher). A child (distinct sid) cannot clobber the pointer.
    if (todoOverlay === undefined) {
      todoOverlay = new TodoOverlay();
      setActiveRenderSession(id);
    }
    if (id !== getActiveRenderSession()) return;
    todoOverlay.setUICtx(ctx.ui);
    todoOverlay.update();
  });

  const replayAndRefresh = (ctx: ExtensionContext): void => {
    const id = sid(ctx);
    replaceState(id, replayFromBranch(ctx));
    if (id === getActiveRenderSession()) todoOverlay?.update();
  };

  pi.on("session_compact", (_event, ctx) => replayAndRefresh(ctx));
  pi.on("session_tree", (_event, ctx) => replayAndRefresh(ctx));

  pi.on("session_shutdown", (_event, ctx) => {
    const s = sid(ctx);
    evictSession(s);
    // Overlay teardown is sid-gated: a child shutdown (distinct sid) must not
    // dispose the foreground's overlay. Only the foreground's own shutdown (or
    // an unknown sid) tears it down and clears the pointer.
    if (s === "" || s === getActiveRenderSession()) {
      try {
        todoOverlay?.dispose();
      } finally {
        todoOverlay = undefined;
        clearActiveRenderSession();
      }
    }
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description:
      "Manage a task list for tracking multi-step progress. Use the `operations[]` field to batch creates, updates, deletes, clears, gets, and lists in a single call — the batch is all-or-nothing (one invalid reference fails the whole call). Within a batch, create prerequisite tasks before dependent ones; later ops can reference ids minted by earlier creates via `blockedBy` / `addBlockedBy` / `update.id` / `delete.id` / `get.id`. Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.",
    promptSnippet: DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
    parameters: TodoParams,

    async execute(_toolCallId, params: TodoParams, _signal, _onUpdate, ctx) {
      const id = sid(ctx);
      const current = getState(id);
      const result = applyOperations(current, params.operations);
      commitState(id, result.state);
      todoOverlay?.update();
      return buildToolResult(params.operations, result.state, result.receipts);
    },
  });

  pi.registerCommand(COMMAND_NAME, {
    description: "Show all todos grouped by status",
    handler: async (_args, ctx) => {
      const visible = listTasks(getState(sid(ctx)), false);
      if (visible.length === 0) {
        ctx.ui.notify(MSG_NO_TODOS, "info");
        return;
      }
      const pending = visible.filter((t) => t.status === "pending");
      const inProgress = visible.filter((t) => t.status === "in_progress");
      const completed = visible.filter((t) => t.status === "completed");

      const lines: string[] = [];
      lines.push(
        `${visible.length} items · ${pending.length} pending · ${inProgress.length} in progress · ${completed.length} completed`,
      );
      if (pending.length > 0) {
        lines.push("── Pending ──");
        for (const task of pending) lines.push(formatTaskLine(task));
      }
      if (inProgress.length > 0) {
        lines.push("── In Progress ──");
        for (const task of inProgress) lines.push(formatTaskLine(task));
      }
      if (completed.length > 0) {
        lines.push("── Completed ──");
        for (const task of completed) lines.push(formatTaskLine(task));
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
