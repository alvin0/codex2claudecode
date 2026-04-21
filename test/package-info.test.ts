import { expect, test } from "bun:test"

import pkg from "../package.json"
import { packageInfo } from "../src/package-info"

test("reads package metadata for UI header", () => {
  expect(packageInfo()).toMatchObject({
    version: pkg.version,
    author: "alvin0 <chaulamdinhai@gmail.com>",
  })
})
