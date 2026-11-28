import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Same alias as tsconfig's "@/*", so components import the same way in tests.
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
