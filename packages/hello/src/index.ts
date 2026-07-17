import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const HelloParams = Type.Object({
  name: Type.String({ description: "Name to greet" }),
});
type HelloParams = Static<typeof HelloParams>;

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.notify("pi-hello loaded", "info");
  });

  pi.registerTool({
    name: "hello",
    label: "Hello",
    description: "Greet someone by name",
    parameters: HelloParams,
    async execute(_toolCallId, params: HelloParams, _signal, _onUpdate, ctx) {
      const text = `Hello, ${params.name}!`;
      ctx.ui.notify(text, "info");
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  });

  pi.registerCommand("hello", {
    description: "Greet the world from pi-hello",
    handler: async (_args, ctx) => {
      ctx.ui.notify("Hello, world!", "info");
    },
  });
}
