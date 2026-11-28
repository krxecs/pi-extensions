# Pi 1.7.0 RPC baseline for #16

Run `pnpm install --frozen-lockfile && pnpm build && pnpm --filter @pixt/subagents test` from the repo root. The test starts a real Pi RPC process in a temporary project against a local, deterministic OpenAI-compatible HTTP server. It needs no API key or external model. One test loads `packages/subagents/src/index.ts` into a real Pi RPC process; the other real-process tests use `packages/subagents/test/rpc-probe.mjs`. The installed extension registers no public tools; the test probe is not part of the published package or the #11 v1 subagent contract.

Tested with Node 26.5.0, pnpm 11.16.0, `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui`, `pi-agent-core`, `pi-mcp`, `pi-codemode`, `pi-schema`, and `pi-telemetry` at 1.7.0, `typebox` 1.3.27, and reference `@gotgenes/pi-subagents` 25.0.5. All companions and reference dependencies resolve in `pnpm-lock.yaml`. The reference is pinned but no parity comparison is claimed.

## Observed commands and outcomes

| Step | Observation |
| --- | --- |
| Start | `RpcClient.start()` launches the pinned CLI in RPC mode with an isolated cwd and ephemeral session. |
| Correlate | The raw JSONL fixture sends `get_state` with ID `state-1` and `prompt` with ID `prompt-2`. Both responses repeat the correct ID, command and `success: true`; `agent_settled` follows the accepted prompt. `RpcClient` also assigns distinct IDs to the test probe's commands. |
| Subscribe | The test probe installs its `onEvent` listener before `start`, `getState`, and `prompt`. |
| Success | `prompt` reports `started`, then `message_end` supplies `BASELINE_OK` with stop reason `stop`, and `agent_settled` fires. Probe result is `completed`. |
| Failure | With HTTP 400 from the fake provider, `prompt` still reports `started`, but the final assistant stop reason is not `stop`. After `agent_settled`, the probe returns `failed` with `isError: true`. |
| Cleanup | The probe bounds startup, commands and settlement with a 30-second local deadline and stops its child. The real-process tests remove temporary files and close the HTTP server. |

The proof covers process startup, correlated commands, listener ordering, and observed final success/failure. A prompt response alone is never a success signal. It does not establish supervision after process crashes, graceful versus forced abort, UI handling, restart, resume, profiles, tool inheritance, or reference events. None of those capabilities should be advertised as verified.

## Core gap for #15 owner

Pi 1.7.0's `RpcClient.handleLine` catches JSON parse errors and ignores malformed stdout records (`dist/modes/rpc/rpc-client.js`). `RpcClient` also reports an unexpected child exit only to pending command requests; it does not notify `onEvent` listeners waiting for `agent_settled`. The probe treats lack of settlement as failure after its deadline, but cannot distinguish a broken stream or early exit immediately through this client API. #11 requires broken streams, child crashes, and lost parents to have typed non-success outcomes. The implementation will need a lower-level supervised JSONL transport or a supported change in `RpcClient`. Do not relax that release gate based on this probe.
