# pi-extensions

Personal [Pi](https://pi.dev) extensions, organized as a pnpm monorepo. Each
extension is its own workspace package that can be loaded locally (no build
step) and published to npm as a Pi package.

## Layout

```
pi-extensions/
├── package.json            # root: private, workspace scripts
├── pnpm-workspace.yaml     # globs packages/*
├── tsconfig.base.json      # shared strict TS config
├── biome.json              # lint + format
├── .changeset/             # changesets versioning
├── scripts/setup.mjs       # registers extensions in ~/.pi/agent/settings.json
└── packages/
    └── hello/              # one package per extension
        ├── package.json    # name, "pi": { "extensions": ["./src/index.ts"] }
        ├── tsconfig.json
        ├── tsdown.config.ts # builds dist/ (ESM + d.mts)
        └── src/index.ts    # the extension (default factory)
```

## How loading works

Each package declares its entry in `package.json`:

```json
"pi": { "extensions": ["./src/index.ts"] }
```

Pi loads the **TypeScript source directly via jiti** — no compilation needed.
This works three ways:

- **Local dev**: `pnpm setup` adds each `packages/<name>` directory to
  `~/.pi/agent/settings.json` `extensions:[]`. Reload with `/reload`.
- **Local install**: `pi install ./packages/hello`
- **Published**: `pi install npm:@krxecs/pi-hello` (after `pnpm release`)

`tsdown` still builds `dist/` (ESM + `.d.mts`) as a compile-time check and a
library entry point, but Pi does not require it.

## Common commands

```bash
pnpm install        # install workspace deps
pnpm setup          # register extensions in Pi's global settings
pnpm build          # tsdown build each package
pnpm typecheck      # tsc --noEmit across packages
pnpm lint           # biome check (local)
pnpm lint:ci        # biome ci (read-only CI check)
pnpm format         # biome format --write
```

The root manifest declares Node.js 20+ package compatibility through `engines`.
`devEngines` pins development to Node 26.5.x and pnpm 11.13.1; pnpm downloads
matching runtimes automatically when the local versions do not match.

## Adding a new extension

1. Copy `packages/hello` to `packages/<your-ext>`.
2. Edit its `package.json`: unique `name` (e.g. `@krxecs/pi-<your-ext>`),
   update the `description`, and confirm `"pi": { "extensions": ["./src/index.ts"] }`.
3. Implement `src/index.ts` (export a default factory `(pi: ExtensionAPI) => void`).
4. `pnpm install && pnpm setup`, then `/reload` in Pi.

## Releasing

```bash
pnpm changeset      # describe the change -> .changeset/*.md
pnpm version        # bump versions, update changelogs
pnpm release        # build + publish to npm
```

GitHub Actions runs validation on pushes and pull requests. The release workflow
uses Changesets to open a version PR and publishes after that PR is merged.
Configure the repository's `NPM_TOKEN` secret before publishing.
