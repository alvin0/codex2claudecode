import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: {
      "bun:test": "vitest",
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/vitest-bun-shim.ts"],
    exclude: ["**/*.d.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text"],
      include: ["src/app/**/*.ts"],
      exclude: [
        "src/app/bin.ts",
        "src/app/bootstrap.ts",
        "src/app/example.ts",
        "src/app/provider-config.ts",
        "src/app/runtime.ts",
      ],
      thresholds: {
        lines: 1.0,
        branches: 1.0,
        functions: 1.0,
        statements: 1.0,
      },
      reporterOptions: {
        text: { skipFull: false },
      },
    },
  },
})
