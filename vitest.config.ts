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
