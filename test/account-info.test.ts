import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  accountInfoFromAuthData,
  accountInfoPath,
  readAccountInfoFile,
  refreshActiveAccountInfo,
  writeAccountInfoFile,
  writeActiveAccountInfo,
} from "../src/upstream/codex/account-info"
import { jwt } from "./helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("writes non-secret account metadata next to the auth file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "account-info-test-"))
  tempDirs.push(dir)
  const authFile = path.join(dir, "auth-codex.json")
  const data = [
    {
      type: "oauth" as const,
      name: "default",
      access: jwt({
        "https://api.openai.com/profile": { email: "user@example.com" },
        "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acct" },
      }),
      refresh: "secret-refresh",
    },
  ]

  await writeFile(authFile, JSON.stringify(data))
  await writeAccountInfoFile(authFile, data)

  expect(accountInfoPath(authFile)).toBe(path.join(dir, ".account-info.json"))
  expect(JSON.parse(await readFile(path.join(dir, ".account-info.json"), "utf8"))).toMatchObject({
    activeAccount: "acct",
    accounts: {
      acct: {
        name: "default",
        email: "user@example.com",
        plan: "pro",
        accountId: "acct",
        updatedAt: expect.any(String),
      },
    },
  })
  expect(await readAccountInfoFile(authFile)).toMatchObject({
    activeAccount: "acct",
    accounts: {
      acct: {
        email: "user@example.com",
      },
    },
  })
  await writeFile(path.join(dir, ".account-info.json"), JSON.stringify({ legacy: { email: "old@example.com", updatedAt: "x" } }))
  expect(await readAccountInfoFile(authFile)).toMatchObject({
    activeAccount: "legacy",
    accounts: {
      legacy: {
        email: "old@example.com",
      },
    },
  })
  expect(await readFile(path.join(dir, ".account-info.json"), "utf8")).not.toContain("secret-refresh")
})

test("uses stable fallback keys for account metadata", () => {
  expect(accountInfoFromAuthData({ type: "oauth", access: "bad", refresh: "r", accountId: "acct" })).toMatchObject({
    activeAccount: "acct",
    accounts: {
      acct: { accountId: "acct" },
    },
  })
  expect(accountInfoFromAuthData([{ type: "oauth", access: "bad", refresh: "r" }], "missing")).toMatchObject({
    activeAccount: "account-1",
    accounts: {
      "account-1": {},
    },
  })
})

test("refreshes metadata for the active account and rewrites the info file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "account-info-refresh-test-"))
  tempDirs.push(dir)
  const authFile = path.join(dir, "auth-codex.json")
  await writeFile(
    authFile,
    JSON.stringify([
      { type: "oauth", name: "first", access: "bad", refresh: "r" },
      {
        type: "oauth",
        name: "second",
        access: jwt({
          "https://api.openai.com/profile": { email: "second@example.com" },
          "https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct_2" },
        }),
        refresh: "r",
      },
    ]),
  )

  await expect(refreshActiveAccountInfo(authFile, "second")).resolves.toMatchObject({
    email: "second@example.com",
    plan: "plus",
    accountId: "acct_2",
  })
  expect(JSON.parse(await readFile(path.join(dir, ".account-info.json"), "utf8"))).toMatchObject({
    activeAccount: "acct_2",
    accounts: {
      acct_2: { email: "second@example.com", plan: "plus", accountId: "acct_2" },
    },
  })

  await writeActiveAccountInfo(authFile, JSON.parse(await readFile(authFile, "utf8")), "first")
  await expect(refreshActiveAccountInfo(authFile)).resolves.toMatchObject({
    name: "first",
  })
  expect(JSON.parse(await readFile(path.join(dir, ".account-info.json"), "utf8"))).toMatchObject({
    activeAccount: "first",
  })
})
