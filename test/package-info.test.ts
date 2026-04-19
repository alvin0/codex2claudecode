import { expect, test } from "bun:test"

import { packageInfo } from "../src/package-info"

test("reads package metadata for UI header", () => {
  expect(packageInfo()).toMatchObject({
    version: "0.1.3",
    author: "alvin0 <chaulamdinhai@gmail.com>",
  })
})
