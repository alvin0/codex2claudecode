import { parseCliOptions } from "./cli"
import { runExample, startRuntime } from "./index"
import { runUi } from "./ui"

if (import.meta.main) {
  const options = parseCliOptions()
  Promise.resolve(process.env.CODEX_RUN_EXAMPLE === "1" ? runExample() : process.env.CODEX_NO_UI === "1" ? startRuntime({ port: options.port }) : runUi(options)).catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
