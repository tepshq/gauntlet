import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // CRAP は Istanbul 形式の coverage-final.json から関数単位で引くため、
      // json reporter は必須。v8 provider は vitest 3.2 以降 AST リマッピングにより
      // Istanbul と同一のレポートを出す。
      reporter: ["text", "json"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
