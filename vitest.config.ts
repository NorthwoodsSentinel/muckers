// Test and coverage config. The coverage bar is the source's (Cliff Hall's inspector): >= 90 on all four
// dimensions, per file, enforced here and therefore in `bun run test` and CI. Never lower it to pass;
// see AGENTS.md "Always test new or modified code".
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    unstubGlobals: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: [["text", { skipFull: false }], "json-summary"],
      thresholds: { perFile: true, lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});
