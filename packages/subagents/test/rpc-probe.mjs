import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const cliPath = join(
  dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"))),
  "cli.js",
);

export async function runProbe({ cwd, prompt, signal }) {
  const client = new RpcClient({
    cliPath,
    cwd,
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
  let stopReason;
  let errorMessage;
  let finalToolError;
  let resolveSettlement;
  const settlement = new Promise((resolve) => {
    resolveSettlement = resolve;
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
    if (event.type === "message_end" && event.message.role === "toolResult") {
      finalToolError = event.message.isError
        ? event.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("") || "Final tool failed"
        : undefined;
    }
    if (event.type === "agent_settled") {
      settled = true;
      resolveSettlement();
    }
  });
  const deadline = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  let abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(new Error("Child cancelled or deadline exceeded"));
    if (deadline.aborted) abort();
    else deadline.addEventListener("abort", abort, { once: true });
  });
  let disposition;
  let transportError;
  try {
    await Promise.race([
      (async () => {
        await client.start();
        // RpcClient assigns and checks a distinct JSONL request ID for each command.
        await client.getState();
        disposition = await client.prompt(prompt);
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
  const status =
    transportError || !settled || stopReason !== "stop" || errorMessage || finalToolError
      ? "failed"
      : "completed";
  const details = {
    status,
    disposition,
    settled,
    text,
    ...(stopReason ? { stopReason } : {}),
    ...(errorMessage || finalToolError || transportError || (!settled && disposition !== "handled")
      ? {
          error:
            errorMessage ||
            finalToolError ||
            transportError ||
            "Child did not settle before deadline",
        }
      : {}),
  };
  return { details, ...(status === "failed" ? { isError: true } : {}) };
}
