# AGENTS.md

Guidance for AI coding agents working in this repository.

## What this repo is

A **pnpm workspace monorepo** of personal [Pi](https://pi.dev) extensions. Each
extension is its own workspace package under `packages/*` that can be loaded
locally (no build step) and published to npm as a Pi package. The root manifest
is private and only holds workspace scripts and shared config.

## Repository layout

```
pi-extensions/
├── package.json            # root: private, workspace scripts, shared devDeps
├── pnpm-workspace.yaml     # globs packages/*; pnpm allowBuilds / release holds
├── tsconfig.base.json      # shared STRICT TypeScript config
├── biome.json              # lint + format (double quotes, 2-space, width 100)
├── .changeset/             # Changesets versioning + config
├── scripts/setup.mjs       # registers packages in ~/.pi/agent/settings.json
├── packages/
│   └── <ext>/              # one package per extension (copy of todo/)
│       ├── package.json    # name, "pi": { "extensions": ["./src/index.ts"] }
│       ├── tsconfig.json   # extends ../../tsconfig.base.json
│       ├── tsdown.config.ts# builds dist/ (ESM + .d.mts), never bundles peers
│       └── src/index.ts    # the extension: default factory (pi) => void
└── .github/workflows/      # ci.yml (lint/typecheck/build) + release.yml
```

## Critical constraints

- **Pi loads TypeScript source directly via jiti** — `package.json` must
  declare `"pi": { "extensions": ["./src/index.ts"] }`. The built `dist/` is
  NOT required for Pi to load an extension; it exists only as a compile-time
  check and a library entry point.
- **Never bundle Pi internals.** `tsdown.config.ts` sets
  `deps.neverBundle` for `/^@earendil-works\//` and `typebox`. These are
  peerDependencies, not bundled deps. Do not add `dependencies` for them.
- **Strict TypeScript** is enforced via `tsconfig.base.json`
  (`strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `isolatedModules`). Mirror these in any new package tsconfig (extend the base).
- **Pin the Pi SDK versions.** Packages pin `@earendil-works/pi-*@0.80.10` as
  devDependencies and list them as `peerDependencies: "*"`. Keep the
  `pnpm-workspace.yaml` `minimumReleaseAgeExclude` block in sync if those pins
  change.
- **Biome is the formatter/linter.** Quotes are doubles, semicolons always,
  indent 2 spaces, line width 100, `organizeImports` is on. Do not introduce a
  second formatter or Prettier config.

## Common commands

```bash
pnpm install        # install workspace deps (CI uses --frozen-lockfile)
pnpm setup          # register extensions in ~/.pi/agent/settings.json, then /reload in Pi
pnpm build          # tsdown build each package (pnpm -r --filter "./packages/*")
pnpm typecheck      # tsc --noEmit across packages
pnpm lint           # biome check (local, may apply fixes)
pnpm lint:ci        # biome ci (read-only; used by CI)
pnpm format         # biome format --write
```

Runtime expectations: `devEngines` pins development to **Node 26.5.x** and
**pnpm 11.13.1** (pnpm auto-downloads matching runtimes via `onFail: download`).
Published/runtime `engines.node` is `>=20`. CI uses Node 26.

## Adding a new extension

1. Copy `packages/todo` to `packages/<your-ext>`.
2. Edit its `package.json`: unique scoped name (`@krxecs/pi-<your-ext>`),
   description, and keep `"pi": { "extensions": ["./src/index.ts"] }`.
3. Implement `src/index.ts` exporting a default factory
   `(pi: ExtensionAPI) => void` (from `@earendil-works/pi-coding-agent`).
4. `pnpm install && pnpm setup`, then `/reload` in Pi.

Keep `main`/`types`/`exports` pointing at `./dist/*` (built) and `files`
including `dist` and `src`. Keep the `publishConfig.access: "public"` and the
`keywords` (`pi-package`, `pi-extension`).

## Releasing (Changesets)

```bash
pnpm changeset    # describe the change -> .changeset/*.md
pnpm version      # bump versions + update changelogs (changeset version)
pnpm release      # build + publish to npm (pnpm build && changeset publish)
```

- `changeset` config: `access: public`, `baseBranch: main`, `commit: false`,
  `privatePackages` not versioned/tagged, `updateInternalDependencies: patch`.
- A GitHub Actions **Release** workflow uses `changesets/action@v2` to open a
  version PR and publish after it merges. The repo must have an `NPM_TOKEN`
  secret configured. Do not publish manually outside this flow.

## CI

- `ci.yml` runs on push to `main` and on PRs: install (frozen lockfile) →
  `pnpm lint:ci` → `pnpm typecheck` → `pnpm build`. All must pass.
- `release.yml` runs on push to `main` (concurrency group `release`).

## Extension authoring notes

- Use `typebox` (`Type.Object`, `Type.String`, …) for tool parameter schemas
  and derive types with `Static<typeof Schema>`.
- Register capabilities via `pi.registerTool({...})`, `pi.registerCommand(...)`,
  and listen with `pi.on("session_start", (event, ctx) => ...)`.
- Surface user-facing output through `ctx.ui.notify(text, "info")`.
