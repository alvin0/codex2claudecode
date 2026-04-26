import { afterEach, describe, expect, test } from "bun:test"

import { normalizeReasoningBody } from "../src/core/reasoning"
import { normalizeRequestBody } from "../src/inbound/openai/normalize"
import { mkdtemp, path, rm, tmpdir, writeFile } from "./helpers"
import {
  extractAccountId,
  extractAccountIdFromClaims,
  parseJwtClaims,
  readAuthFile,
} from "../src/upstream/codex/auth"
import { jwt } from "./helpers"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempFile(contents: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-standalone-test-"))
  tempDirs.push(dir)
  const file = path.join(dir, "auth.json")
  await writeFile(file, contents)
  return file
}

describe("auth helpers", () => {
  test("reads valid oauth auth files and rejects malformed files", async () => {
    await expect(readAuthFile(await tempFile(JSON.stringify({ type: "oauth", access: "a", refresh: "r" })))).resolves.toEqual({
      type: "oauth",
      access: "a",
      refresh: "r",
    })
    await expect(
      readAuthFile(
        await tempFile(
          JSON.stringify([
            { type: "oauth", name: "first", access: "a", refresh: "r" },
            { type: "oauth", name: "second", access: "b", refresh: "s" },
          ]),
        ),
        "second",
      ),
    ).resolves.toMatchObject({ name: "second", access: "b" })
    await expect(readAuthFile(await tempFile(JSON.stringify({ type: "api" })))).rejects.toThrow("not an oauth")
    await expect(readAuthFile(await tempFile(JSON.stringify({ type: "oauth", refresh: "r" })))).rejects.toThrow("missing access")
    await expect(readAuthFile(await tempFile(JSON.stringify({ type: "oauth", access: "a" })))).rejects.toThrow("missing refresh")
    await expect(readAuthFile(await tempFile(JSON.stringify([])))).rejects.toThrow("does not contain any accounts")
    await expect(readAuthFile(await tempFile(JSON.stringify([{ type: "oauth", name: "first", access: "a", refresh: "r" }])), "missing")).rejects.toThrow(
      "does not contain account missing",
    )
  })

  test("parses JWT claims and extracts ChatGPT account IDs from all supported locations", () => {
    expect(parseJwtClaims("bad")).toBeUndefined()
    expect(parseJwtClaims("a.bad.c")).toBeUndefined()
    expect(parseJwtClaims(jwt({ chatgpt_account_id: "acct_1" }))).toEqual({ chatgpt_account_id: "acct_1" })
    expect(extractAccountIdFromClaims({ chatgpt_account_id: "direct" })).toBe("direct")
    expect(extractAccountIdFromClaims({ "https://api.openai.com/auth": { chatgpt_account_id: "namespaced" } })).toBe("namespaced")
    expect(extractAccountIdFromClaims({ organizations: [{ id: "org_1" }] })).toBe("org_1")
    expect(extractAccountIdFromClaims({})).toBeUndefined()
  })

  test("extracts account IDs from id_token first, then access_token", () => {
    expect(extractAccountId({ access_token: jwt({ chatgpt_account_id: "access" }), refresh_token: "r" })).toBe("access")
    expect(
      extractAccountId({
        id_token: jwt({ chatgpt_account_id: "id" }),
        access_token: jwt({ chatgpt_account_id: "access" }),
        refresh_token: "r",
      }),
    ).toBe("id")
    expect(extractAccountId({ id_token: "bad", access_token: "bad", refresh_token: "r" })).toBeUndefined()
    expect(extractAccountId({ refresh_token: "r", access_token: "" })).toBeUndefined()
  })
})

describe("request normalization", () => {
  test("normalizes GPT-5 effort suffixes into nested reasoning", () => {
    expect(normalizeReasoningBody({ model: "gpt-5.4_xhigh", input: "hi" })).toEqual({
      model: "gpt-5.4",
      input: "hi",
      reasoning: { effort: "xhigh" },
    })
    expect(normalizeReasoningBody({ model: "gpt-5.4", reasoning_effort: "low" })).toEqual({
      model: "gpt-5.4",
      reasoning: { effort: "low" },
    })
    expect(normalizeReasoningBody({ model: "gpt-5.4_high", reasoning: { effort: "none", summary: "auto" } })).toEqual({
      model: "gpt-5.4",
      reasoning: { effort: "none", summary: "auto" },
    })
    expect(normalizeReasoningBody({ model: "gpt-4.1", reasoning_effort: "high" })).toEqual({ model: "gpt-4.1" })
    expect(normalizeReasoningBody({ input: "no model" })).toEqual({ input: "no model" })
  })

  test("normalizes OpenAI-compatible response and chat bodies", () => {
    expect(normalizeRequestBody("/v1/responses", { model: "gpt-5.4_high", input: "hello" })).toEqual({
      model: "gpt-5.4",
      reasoning: { effort: "high" },
      instructions: "You are a helpful assistant.",
      store: false,
      stream: true,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    })

    expect(
      normalizeRequestBody("/v1/chat/completions", {
        model: "gpt-5.4",
        messages: [
          { role: "system", content: "sys" },
          { role: "developer", content: { text: "dev" } },
          { role: "user", content: "hi" },
          { role: "assistant", content: "there" },
          { role: "tool", content: [{ type: "input_text", text: "tool" }] },
          { role: "ignored", content: "nope" },
        ],
      }),
    ).toMatchObject({
      model: "gpt-5.4",
      instructions: "sys\n\ndev",
      messages: undefined,
      store: false,
      stream: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: "hi" }] },
        { role: "assistant", content: [{ type: "output_text", text: "there" }] },
        { role: "tool", content: [{ type: "input_text", text: "tool" }] },
      ],
    })

    expect(normalizeRequestBody("/anything", { model: "other", store: true, stream: false, input: [] })).toEqual({
      model: "other",
      store: true,
      stream: false,
      input: [],
    })
  })
})
