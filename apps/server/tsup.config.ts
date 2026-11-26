import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node24",
  // The shared package ships TypeScript source, so bundle it into the output.
  noExternal: ["@collab/shared"],
  clean: true,
  sourcemap: true,
});
