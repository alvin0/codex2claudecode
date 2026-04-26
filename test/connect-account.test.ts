import { afterEach, expect, test } from "bun:test"

import { connectAccount, connectAccountFromCodexAuth } from "../src/upstream/codex/connect-account"
import { jwt, mkdtemp, path, readFile, rm, tmpdir, writeFile } from "./helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function authFile(contents: unknown = []) {
  const dir = await mkdtemp(path.join(tmpdir(), "connect-account-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth-codex.json")
  await writeFile(file, JSON.stringify(contents))
  return file
}

test("connects a new account and writes account info", async () => {
  const file = await authFile()
  const accessToken = jwt({
    "https://api.openai.com/profile": { email: "new@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_new", chatgpt_plan_type: "pro" },
  })

  await expect(
    connectAccount(
      file,
      { accountId: "", accessToken: "ignored", refreshToken: " refresh \n" },
      {
        issuer: "https://issuer.test",
        fetch: ((url, init) => {
          expect(String(url)).toBe("https://issuer.test/oauth/token")
          expect(String(init?.body)).toContain("refresh_token=refresh")
          return Promise.resolve(Response.json({ access_token: accessToken, refresh_token: "new-refresh", expires_in: 60 }))
        }) as unknown as typeof fetch,
      },
    ),
  ).resolves.toMatchObject({
    accountId: "acct_new",
  })
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject([{ type: "oauth", access: accessToken, refresh: "new-refresh", accountId: "acct_new" }])
  expect(JSON.parse(await readFile(path.join(path.dirname(file), ".account-info.json"), "utf8"))).toMatchObject({
    activeAccount: "acct_new",
    accounts: {
      acct_new: { email: "new@example.com", plan: "pro", accountId: "acct_new" },
    },
  })
})

test("updates an existing connected account and validates required fields", async () => {
  const file = await authFile([{ type: "oauth", access: "old", refresh: "old", accountId: "acct" }])
  const sourceDir = await mkdtemp(path.join(tmpdir(), "codex-cli-auth-test-"))
  tempDirs.push(sourceDir)
  const codexFile = path.join(sourceDir, "auth.json")
  await writeFile(codexFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "acct", access_token: "cli-old", refresh_token: "cli-refresh" } }))

  await connectAccount(file, { accountId: "acct", accessToken: "ignored", refreshToken: "refresh" }, { codexAuthFile: codexFile, fetch: (() => Promise.resolve(Response.json({ access_token: "new", refresh_token: "new-refresh" }))) as unknown as typeof fetch })
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject([{ access: "new", refresh: "new-refresh", accountId: "acct" }])
  expect(JSON.parse(await readFile(codexFile, "utf8"))).toMatchObject({ tokens: { account_id: "acct", access_token: "new", refresh_token: "new-refresh" } })

  await connectAccount(file, { accountId: "acct", accessToken: "ignored", refreshToken: "fallback-refresh" }, { codexAuthFile: codexFile, fetch: (() => Promise.resolve(Response.json({ access_token: "newer" }))) as unknown as typeof fetch })
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject([{ access: "newer", refresh: "fallback-refresh", accountId: "acct" }])
  expect(JSON.parse(await readFile(codexFile, "utf8"))).toMatchObject({ tokens: { account_id: "acct", access_token: "newer", refresh_token: "fallback-refresh" } })

  await writeFile(codexFile, JSON.stringify({ auth_mode: "chatgpt", tokens: { account_id: "other", access_token: "cli-old", refresh_token: "cli-refresh" } }))
  await connectAccount(file, { accountId: "acct", accessToken: "ignored", refreshToken: "refresh-2" }, { codexAuthFile: codexFile, fetch: (() => Promise.resolve(Response.json({ access_token: "newest", refresh_token: "newest-refresh" }))) as unknown as typeof fetch })
  expect(JSON.parse(await readFile(codexFile, "utf8"))).toMatchObject({ tokens: { account_id: "other", access_token: "cli-old", refresh_token: "cli-refresh" } })

  await expect(connectAccount(file, { accountId: "", accessToken: "bad", refreshToken: "refresh" }, { fetch: (() => Promise.resolve(Response.json({ access_token: "bad", refresh_token: "refresh" }))) as unknown as typeof fetch })).rejects.toThrow("accountId is required")
  await expect(connectAccount(file, { accountId: "acct", accessToken: "", refreshToken: "refresh" }, { fetch: (() => Promise.resolve(new Response("denied", { status: 400 }))) as unknown as typeof fetch })).rejects.toThrow("Token refresh failed")
  await expect(connectAccount(file, { accountId: "acct", accessToken: "access", refreshToken: "" })).rejects.toThrow("refreshToken is required")
})

test("connects from Codex CLI auth file", async () => {
  const file = await authFile()
  const sourceDir = await mkdtemp(path.join(tmpdir(), "codex-cli-auth-test-"))
  tempDirs.push(sourceDir)
  const source = path.join(sourceDir, "auth.json")
  const accessToken = jwt({
    "https://api.openai.com/profile": { email: "codex@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_cli", chatgpt_plan_type: "pro" },
  })
  await writeFile(
    source,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct_cli",
        access_token: "old",
        refresh_token: " refresh-cli ",
      },
    }),
  )

  await expect(
    connectAccountFromCodexAuth(file, source),
  ).resolves.toMatchObject({ accountId: "acct_cli" })
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject([{
    accountId: "acct_cli",
    access: "old",
    refresh: "refresh-cli",
    sourceAuthFile: source,
    sourceAccountKey: "acct_cli",
  }])
})

test("rejects unsupported Codex CLI auth files", async () => {
  const file = await authFile()
  const sourceDir = await mkdtemp(path.join(tmpdir(), "codex-cli-auth-test-"))
  tempDirs.push(sourceDir)
  const source = path.join(sourceDir, "auth.json")
  await writeFile(source, JSON.stringify({ auth_mode: "api", tokens: {} }))
  await expect(connectAccountFromCodexAuth(file, source)).rejects.toThrow("Unsupported auth_mode")
})
