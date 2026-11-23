# Agent guidance

This is a pnpm workspace of Pi extensions. Each package under `packages/*` loads from TypeScript source and builds separately for npm.

## Working on an extension

- Keep the `pi.extensions` entry in each package manifest pointed at `./src/index.ts`. Pi loads that source directly; `dist/` is the built library entry point, not the Pi entry point.
- Export a default extension factory from `src/index.ts` that accepts `ExtensionAPI`. Use `typebox` for tool schemas.
- Keep Pi SDK packages and `typebox` as peers. The package's `tsdown.config.ts` must exclude them from bundling.
- Extend `tsconfig.base.json` in package TypeScript configs. Keep Pi SDK devDependency pins aligned with `pnpm-workspace.yaml` release-age exclusions when changing versions.
- Follow `biome.json` for formatting, linting, and imports. Do not introduce another formatter.
- Check package scripts and the root `package.json` for available commands. Run `pnpm lint:ci`, `pnpm typecheck`, and `pnpm build` before handing off code changes.
- When registering extension packages locally, run `pnpm setup` to add them to Pi's settings, then use `/reload` in Pi.
- Publish through the repository's release workflow rather than running a manual publish command.

## Agent skills

### Issue tracker

Issues live in GitHub Issues for `krxecs/pi-extensions`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a multi-context layout with a root glossary map and package glossaries. See `docs/agents/domain.md`.
