export * from "./src/index"

import { parseCliOptions } from "./src/app/cli"
import { setupCodexCli } from "./src/app/codex-cli-config"
import { runExample, startRuntime } from "./src/index"
import { runUi } from "./src/ui"

if (import.meta.main) {
  const options = parseCliOptions()
  Promise.resolve(options.setupCodexCli ? setupCodexCli({ port: options.port, makeDefault: options.codexCliMakeDefault }) : process.env.CODEX_RUN_EXAMPLE === "1" ? runExample() : process.env.CODEX_NO_UI === "1" ? startRuntime({ port: options.port, hostname: options.hostname, apiPassword: options.password }) : runUi(options)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
