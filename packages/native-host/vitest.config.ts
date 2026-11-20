import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Tests bind local sockets and spawn child processes; keep them from racing each other.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
