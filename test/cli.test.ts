import { expect, test } from "bun:test"

import { parseCliOptions } from "../src/cli"

test("parses port flags", () => {
  expect(parseCliOptions(["-p", "8786"])).toEqual({ port: 8786 })
  expect(parseCliOptions(["--port", "8785"])).toEqual({ port: 8785 })
  expect(parseCliOptions(["--port=8784"])).toEqual({ port: 8784 })
  expect(parseCliOptions([])).toEqual({})
  expect(() => parseCliOptions(["--port", "bad"])).toThrow("Invalid port")
})
