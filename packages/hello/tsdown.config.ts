import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
  // Pi bundles these at runtime; never bundle them into the extension.
  deps: {
    neverBundle: [/^@earendil-works\//, "typebox"],
  },
});
