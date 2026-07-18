# AGENTS.md — packages/todo

Guidance for AI coding agents working on the **`@krxecs/pi-todo`** extension.

## What this package is

A Pi extension that adds a multi-item **`todo`** tool plus a **`/todos`** slash
command. It is modeled on the community `rpiv-todo` extension (Pi has no built-in todo tool). Intended for planning and tracking multi-step work such as
research, design, and implementation inside a Pi coding session.

- **Package name:** `@krxecs/pi-todo`
- **Entry (loaded by Pi):** `src/index.ts` — declared in
  `package.json` under `"pi": { "extensions": ["./src/index.ts"] }`.
- **Built artifact:** `dist/` (ESM `.mjs` + `.d.mts`). The build exists only as
  a compile-time check and a library entry point — **Pi loads the TypeScript
  source directly via jiti**, so `dist/` is not required for the extension to run.
- **No on-disk storage.** Tasks are reconstructed from each session's branch
  (the transcript Pi persists) on `/reload` — see "Persistence model" below.

## Layout

```
packages/todo/
├── package.json        # name, "pi": { "extensions": ["./src/index.ts"] }, peer/dev deps
├── tsconfig.json       # extends ../../tsconfig.base.json
├── tsdown.config.ts    # builds dist/ (ESM + .d.mts), never bundles peers
├── src/index.ts        # the entire extension: default factory (pi) => void
└── dist/               # built output (do not edit by hand; regenerate with build)
```

`src/index.ts` is the single source of truth — there are no submodules.

## Critical constraints

- **Pi loads TypeScript source directly via jiti.** Keep
  `"pi": { "extensions": ["./src/index.ts"] }` in `package.json`. The built
  `dist/` is NOT required for Pi to load the extension; it exists only as a
  compile-time check and a library entry point.
- **Never bundle Pi internals.** `tsdown.config.ts` sets `deps.neverBundle`
  for `/^@earendil-works\//` and `typebox`. These are `peerDependencies`
  (`*`), not bundled deps — do not add them to `dependencies`. The pinned
  `@earendil-works/pi-*` versions (`0.80.10`) and `typebox` are
  `devDependencies` only.
- **Strict TypeScript** is enforced via `tsconfig.base.json`
  (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `isolatedModules`).
  Mirror these in any new file; keep `tsconfig.json` extending the base.
- **Tool parameter schemas use `typebox`.** Derive types with `Static<typeof
  Schema>`. The schema is `TodoParams`; `TaskMutationParams` is the open-shape
  input bag the reducer accepts (index signature so params pass through without
  casts).
- **Keep `main`/`types`/`exports` pinned to `./dist/*`** (built) and `files`
  including `dist` and `src`. Keep `publishConfig.access: "public"` and the
  `keywords` (`pi-package`, `pi-extension`, `todo`).

## Behavior overview

### The `todo` tool

Six actions, registered via `pi.registerTool({ name: "todo", ... })`:

| Action | Purpose | Required params |
|---|---|---|
| `create` | New task (4-state status machine starts at `pending`) | `subject` |
| `update` | Change status/fields/dependencies | `id` |
| `list` | List all tasks (hidden `deleted` unless `includeDeleted`) | — |
| `get` | Single task details | `id` |
| `delete` | Tombstone (status → `deleted`, kept in array) | `id` |
| `clear` | Reset all (`tasks: []`, `nextId: 1`) | — |

- **Status machine:** `pending → in_progress → completed`, plus `deleted` as a
  tombstone. `StatusEnum` (the schema) only allows the first three on write;
  `deleted` is reached only via the `delete` action.
- **Dependencies:** `blockedBy` ids. On `create`, pass `blockedBy` as the
  initial set. On `update`, use `addBlockedBy` / `removeBlockedBy` (additive
  merge — do NOT resend the full array).
- **Metadata:** free-form `Record<string, unknown>`. On `update`, pass a key
  with a `null` value to delete that key (`mergeMetadata`).
- **`activeForm`:** present-continuous spinner label shown while `in_progress`
  (e.g. `'writing tests'`).

### The `/todos` command

Registered via `pi.registerCommand("todos", ...)`. Prints the live list grouped
by status (Pending / In Progress / Completed) via `ctx.ui.notify`. Shows a
"No todos yet" notice when empty.

### Persistence model (branch replay)

There is **no separate on-disk file**. Every `todo` tool result echoes the full
task snapshot under `details` (`{ action, tasks, nextId }`). On `session_start`,
`session_compact`, and `session_tree`, `replayFromBranch(ctx)` walks the current
branch (the conversation transcript Pi persists) in chronological order and
reconstructs state from the **last** `toolResult` whose `toolName === "todo"`
and whose `details` matches the `TaskDetails` shape (last-write-wins).

> If you change what the tool result `details` carries, you MUST keep
> `isTaskDetails` aligned — branch replay depends on that exact shape.

### Per-session isolation + overlay

- State is held in a `Map<sessionId, TaskState>` (`sessions`). Each session
  replays into its own slot (sid-gated) so a forked/child session can never read
  or clobber another session's tasks.
- The overlay is drawn by `TodoOverlay` via Pi's `setWidget` component-factory
  form, placed `aboveEditor`. It reads live state at render time and refreshes in
  place via `tui.requestRender()`.
- Only the **first UI-bearing `session_start`** (the foreground/interactive
  launcher) claims the shared overlay (`setActiveRenderSession`). A child session
  with a distinct `sid` cannot steal or tear down the foreground overlay.
- `ctrl+shift+t` toggles collapse/expand (`COLLAPSE_KEY`).
- Overlay is capped at `MAX_OVERLAY_LINES = 12` (header + task lines + optional
  `+N more` + trailing blank). On overflow, lowest-priority tasks drop first
  (`KEEP_PRIORITY`: `pending`/`in_progress` kept, `completed` dropped, `deleted`
  dropped last), and survivors are returned in original insertion order so
  `in_progress` stays where it was created.

## Extension authoring notes

- Default export is the factory: `(pi: ExtensionAPI) => void`.
- Register capabilities via `pi.registerTool({...})`, `pi.registerCommand(...)`,
  `pi.registerShortcut(...)`, and listen with `pi.on("session_start" | ...)`.
- Surface user-facing output through `ctx.ui.notify(text, "info")`.
- The reducer `applyTaskMutation` is **pure** — all session store mutation goes
  through `commitState` / `replaceState` / `evictSession`. Keep new mutations
  pure and side-effect-free.
- The exhaustive `switch` over `TaskAction` ends with a `never` check; adding an
  action requires handling it there and extending the schema.

## Common commands

Run these from the **repo root** (pnpm workspace):

```bash
pnpm build          # tsdown build packages/todo -> dist/ (pnpm -r --filter "./packages/*")
pnpm typecheck      # tsc --noEmit for this package
pnpm lint           # biome check (local, may apply fixes)
pnpm setup          # register extensions in ~/.pi/agent/settings.json, then /reload in Pi
```

Inside the package directory you can also run its own scripts:
`pnpm build` (`tsdown`) and `pnpm typecheck` (`tsc --noEmit`).

## Releasing

This package is versioned and published through the **Changesets** flow at the
repo root (see the repo-level AGENTS.md). Do not publish manually. Add a
changeset describing the change (`pnpm changeset`), then the repo CI opens a
version PR and publishes after merge.
