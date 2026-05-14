import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/http.ts"], // entry points; exercised via integration smoke tests instead
      reporter: ["text", "html"],
    },
  },
});
