import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "bun:test": "vitest",
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The property suites run tens of thousands of assertions and overrun the 5 s default.
    // Twice the `--timeout` the `test` script passes to `bun test`, because this config only
    // ever runs under istanbul instrumentation, which roughly doubles their wall clock.
    testTimeout: 60_000,
    setupFiles: ["test/vitest-bun-shim.ts"],
    exclude: ["**/*.d.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/app/bin.ts",
        "src/app/bootstrap.ts",
        "src/app/example.ts",
        "src/app/runtime.ts",
        "src/ui/**",
      ],
      reporterOptions: {
        text: { skipFull: false },
      },
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
      },
    },
  },
})
