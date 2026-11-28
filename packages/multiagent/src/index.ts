import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ExtensionAPI, RpcClient } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const cliPath = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))),
  "cli.js",
);

/** A narrow, synchronous feasibility probe. It does not implement the v1 multiagent contract. */
export default function multiagent(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "rpc_baseline",
    label: "RPC baseline",
    description:
      "Start one isolated Pi RPC coding child, wait for final settlement, and report its observed outcome. Feasibility probe only.",
    parameters: Type.Object({ prompt: Type.String({ minLength: 1 }) }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const client = new RpcClient({
        cliPath,
        cwd: ctx.cwd,
        args: [
          "--no-session",
          "--no-extensions",
          "--no-mcp",
          "--no-skills",
          "--no-prompt-templates",
          "--no-themes",
          "--no-context-files",
        ],
      });
      let settled = false;
      let text = "";
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let finish!: () => void;
      const settlement = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const unsubscribe = client.onEvent((event) => {
        if (event.type === "message_end" && event.message.role === "assistant") {
          text = event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          stopReason = event.message.stopReason;
          errorMessage = event.message.errorMessage;
        }
        if (event.type === "agent_settled") {
          settled = true;
          finish();
        }
      });
      const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
      let abort!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error("Child cancelled or deadline exceeded"));
        if (deadline.aborted) abort();
        else deadline.addEventListener("abort", abort, { once: true });
      });
      let disposition: string | undefined;
      let transportError: string | undefined;
      try {
        await Promise.race([
          (async () => {
            await client.start();
            // RpcClient assigns and checks a distinct JSONL request ID for each command.
            await client.getState();
            disposition = await client.prompt(params.prompt);
            if (disposition !== "handled") await settlement;
          })(),
          interrupted,
        ]);
      } catch (error) {
        transportError = error instanceof Error ? error.message : String(error);
      } finally {
        deadline.removeEventListener("abort", abort);
        unsubscribe();
        await client.stop();
      }
      const status = transportError || !settled || stopReason !== "stop" ? "failed" : "completed";
      const details = {
        status,
        disposition,
        settled,
        text,
        ...(stopReason ? { stopReason } : {}),
        ...(errorMessage || transportError || (!settled && disposition !== "handled")
          ? { error: errorMessage ?? transportError ?? "Child did not settle before deadline" }
          : {}),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
        ...(status === "failed" ? { isError: true } : {}),
      };
    },
  });
}
