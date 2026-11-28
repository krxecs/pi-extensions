import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { RpcClient } from "@earendil-works/pi-coding-agent";

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { default: extension } = await import(path.join(packageDir, "dist/index.mjs"));
const cliPath = path.join(
  packageDir,
  "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
);
const manifest = JSON.parse(
  await (await import("node:fs/promises")).readFile(path.join(packageDir, "package.json"), "utf8"),
);

async function fixture(responseStatus = 200) {
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({
      url: request.url,
      body: await new Promise((resolve) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => resolve(body));
      }),
    });
    if (responseStatus !== 200) {
      response.writeHead(responseStatus);
      response.end("upstream failure");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = {
      id: "chatcmpl-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: "smoke-model",
      choices: [
        { index: 0, delta: { role: "assistant", content: "BASELINE_OK" }, finish_reason: null },
      ],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(
      `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rpc-baseline-"));
  const agentDir = path.join(directory, "agent");
  await (await import("node:fs/promises")).mkdir(agentDir);
  await writeFile(path.join(directory, "README.md"), "Temporary RPC project\n");
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        smoke: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          api: "openai-completions",
          apiKey: "test-only",
          models: [{ id: "smoke-model", contextWindow: 8192, maxTokens: 128 }],
        },
      },
    }),
  );
  return {
    directory,
    agentDir,
    requests,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function within(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runTool(fixture, signal) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.agentDir;
  let tool;
  extension({
    registerTool(value) {
      tool = value;
    },
  });
  assert.equal(tool?.name, "rpc_baseline");
  try {
    return await tool.execute(
      "smoke",
      { prompt: "Reply BASELINE_OK without calling tools." },
      signal,
      undefined,
      {
        cwd: fixture.directory,
        sessionManager: { getSessionId: () => "parent-test" },
      },
    );
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
}

test("pinned Pi 1.7.0 RPC child settles after a correlated prompt in a temporary project", {
  timeout: 60000,
}, async () => {
  assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], "1.7.0");
  assert.equal(manifest.devDependencies["@gotgenes/pi-subagents"], "25.0.5");
  const project = await fixture();
  try {
    const result = await runTool(project);
    assert.equal(result.details.status, "completed");
    assert.equal(result.details.disposition, "started");
    assert.equal(result.details.settled, true);
    assert.equal(result.details.text, "BASELINE_OK");
    assert.equal(result.isError, undefined);
    assert.equal(project.requests.length, 1);
    assert.equal(project.requests[0].url, "/v1/chat/completions");
  } finally {
    await project.close();
  }
});

test("real Pi JSONL matches command IDs and settles after prompt acceptance", {
  timeout: 15000,
}, async () => {
  const project = await fixture();
  const child = spawn(
    process.execPath,
    [
      cliPath,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-mcp",
      "--no-context-files",
      "--provider",
      "smoke",
      "--model",
      "smoke-model",
    ],
    {
      cwd: project.directory,
      env: { ...process.env, PI_CODING_AGENT_DIR: project.agentDir },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    const records = await new Promise((resolve, reject) => {
      let pending = Buffer.alloc(0);
      const events = [];
      const timer = setTimeout(() => reject(new Error("No agent_settled event")), 10000);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Child exited before settlement: ${code}`)));
      child.stdout.on("data", (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.includes(10)) {
          const newline = pending.indexOf(10);
          const record = JSON.parse(pending.subarray(0, newline).toString("utf8"));
          pending = pending.subarray(newline + 1);
          events.push(record);
          if (record.type === "agent_settled") {
            clearTimeout(timer);
            resolve(events);
          }
        }
      });
      child.stdin.write(`${JSON.stringify({ id: "state-1", type: "get_state" })}\n`);
      child.stdin.write(
        `${JSON.stringify({ id: "prompt-2", type: "prompt", message: "Reply BASELINE_OK." })}\n`,
      );
    });
    const responses = records.filter((r) => r.type === "response");
    assert.deepEqual(
      responses.map((r) => [r.id, r.command, r.success]),
      [
        ["state-1", "get_state", true],
        ["prompt-2", "prompt", true],
      ],
    );
    assert.equal(responses[1].data.disposition, "started");
    assert.equal(
      records.find((r) => r.type === "message_end" && r.message.role === "assistant")?.message
        .stopReason,
      "stop",
    );
    assert.ok(
      records.findIndex((r) => r.type === "agent_settled") >
        records.findIndex((r) => r.id === "prompt-2"),
    );
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
    await project.close();
  }
});

test("an accepted RPC prompt that fails at the provider is not reported as success", {
  timeout: 60000,
}, async () => {
  const project = await fixture(400);
  try {
    const result = await runTool(project);
    assert.equal(result.details.disposition, "started");
    assert.equal(result.details.settled, true);
    assert.equal(result.details.status, "failed");
    assert.equal(result.isError, true);
    assert.notEqual(result.details.stopReason, "stop");
    assert.equal(project.requests.length, 1);
  } finally {
    await project.close();
  }
});

test("a stalled RPC command cannot prevent cancellation", { timeout: 10000 }, async () => {
  const project = await fixture();
  const original = RpcClient.prototype.getState;
  const controller = new AbortController();
  let reached;
  const entered = new Promise((resolve) => {
    reached = resolve;
  });
  let client;
  RpcClient.prototype.getState = function () {
    client = this;
    reached();
    return new Promise(() => {});
  };
  try {
    const resultPromise = runTool(project, controller.signal);
    await within(entered, 5000, "getState was not reached");
    controller.abort();
    const result = await within(resultPromise, 2000, "Tool did not stop a stalled command");
    assert.equal(result.details.status, "failed");
    assert.equal(result.details.settled, false);
    assert.equal(result.isError, true);
    assert.match(result.details.error, /cancelled or deadline exceeded/);
  } finally {
    RpcClient.prototype.getState = original;
    controller.abort();
    await client?.stop();
    await project.close();
  }
});
