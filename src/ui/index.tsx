import React from "react"
import { render } from "ink"

import { CodexCodeApp } from "./app"
import type { CliOptions } from "../app/cli"

export function runUi(options?: CliOptions) {
  return render(<CodexCodeApp port={options?.port} />)
}

export { CodexCodeApp }
