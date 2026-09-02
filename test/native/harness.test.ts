import { afterEach, describe, expect, test } from "bun:test"

import { readTextFile, writeTextFile } from "../../src/core/bun-fs"
import { bunPath as path, tempDir } from "../../src/core/paths"
import type { RequestLogEntry } from "../../src/core/types"
import { exists, mkdtemp, rm } from "../helpers"

import {
  NATIVE_LIVE_CASES,
  NATIVE_LIVE_CASE_IDS,
  NATIVE_MCP_SERVER_URL_PLACEHOLDER,
  nativeBaselineCaseIds,
  nativeLiveCase,
  resolveNativeCaseBody,
} from "./cases"
import { copyNativeCredentials, credentialFingerprint, NATIVE_PROTECTED_CREDENTIAL_FILES } from "./credentials"
import { isEnablingValue, NATIVE_FLAG_NAMES, startNativeGateway } from "./gateway"
import { nativeCaseFeatures, nativeMatrixObservationsFor, writeNativeMatrixObservations } from "./matrix-records"
import { loadNativeMatrixObservations } from "./matrix-source"
import { eventTypes, featureNotices, textNotices, upstreamEffortLevel } from "./observation"
import { captureNativeObservation, parseSseText } from "./response-capture"
import { evaluateAssertions } from "./run-case"
import type { NativeLiveObservation } from "./types"

const tempDirs: string[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function observation(overrides: Partial<NativeLiveObservation> = {}): NativeLiveObservation {
  return {
    caseId: "sampling-declared",
    status: 200,
    headers: {},
    clientBody: "",
    clientEvents: [],
    ...overrides,
  }
}

describe("native live case registry", () => {
  test("holds exactly the fourteen named cases with no duplicates", () => {
    expect(NATIVE_LIVE_CASES.map((liveCase) => liveCase.id)).toEqual([...NATIVE_LIVE_CASE_IDS])
    expect(new Set(NATIVE_LIVE_CASE_IDS).size).toBe(14)
  })

  test("records the pre-implementation baseline split from the design", () => {
    expect(nativeBaselineCaseIds("green")).toEqual([
      "sampling-native",
      "passthrough-off",
      "messages-no-passthrough",
      "web-search-native",
    ])
    expect(nativeBaselineCaseIds("red")).toHaveLength(10)
  })

  test("every case targets a connected upstream, an inbound route, and at least one assertion", () => {
    for (const liveCase of NATIVE_LIVE_CASES) {
      expect(["kiro", "codex"]).toContain(liveCase.upstream)
      expect(["/v1/messages", "/v1/responses"]).toContain(liveCase.route)
      expect(liveCase.assertions.length).toBeGreaterThan(0)
      for (const flag of Object.keys(liveCase.flags)) expect(NATIVE_FLAG_NAMES).toContain(flag as never)
    }
  })

  test("only the MCP cases carry the fixture placeholder, and it resolves to the fixture url", () => {
    const withPlaceholder = NATIVE_LIVE_CASES.filter((liveCase) =>
      JSON.stringify(liveCase.body).includes(NATIVE_MCP_SERVER_URL_PLACEHOLDER),
    ).map((liveCase) => liveCase.id)
    expect(withPlaceholder).toEqual(["mcp-toolset-kiro", "mcp-approval-reject"])

    const resolved = resolveNativeCaseBody(nativeLiveCase("mcp-toolset-kiro"), { mcpServerUrl: "http://127.0.0.1:1234/mcp" })
    expect(JSON.stringify(resolved)).toContain("http://127.0.0.1:1234/mcp")
    expect(JSON.stringify(resolved)).not.toContain(NATIVE_MCP_SERVER_URL_PLACEHOLDER)
  })

  test("resolving a body returns a copy so a run cannot mutate the registry", () => {
    const resolved = resolveNativeCaseBody(nativeLiveCase("sampling-declared"))
    resolved.temperature = 1
    expect(nativeLiveCase("sampling-declared").body.temperature).toBe(0.2)
  })

  test("a case needing the fixture url fails loudly when it is missing", () => {
    expect(() => resolveNativeCaseBody(nativeLiveCase("mcp-approval-reject"))).toThrow(/MCP fixture URL/)
  })
})

describe("native harness observation", () => {
  test("parses the rendered degrade warning into one notice per feature", () => {
    const notices = textNotices(
      [
        "[gateway] 2 requested features were not honored as sent:",
        "- sampling: temperature=0.2 was not sent upstream",
        "- toolChoiceForced: tool_choice \"required\" was applied by narrowing the tool list",
        "",
        "ok",
      ].join("\n"),
    )
    expect(notices.map((notice) => notice.feature)).toEqual(["sampling", "toolChoiceForced"])
    expect(notices[0].detail).toContain("temperature=0.2")
    expect(notices[0].source).toBe("text")
  })

  test("prefers telemetry notices over the rendered text", () => {
    const notices = featureNotices(
      observation({
        clientJson: { content: [{ type: "text", text: "[gateway] 1 …\n- sampling: from text" }] },
        requestLog: {
          id: "1",
          at: "now",
          method: "POST",
          path: "/v1/messages",
          status: 200,
          durationMs: 1,
          error: "-",
          requestHeaders: {},
          proxy: {
            label: "Kiro messages",
            method: "POST",
            target: "upstream",
            status: 200,
            durationMs: 1,
            error: "-",
            telemetry: { featureNotices: [{ feature: "sampling", policy: "degrade", detail: "from telemetry" }] },
          } as never,
        },
      }),
    )
    expect(notices).toEqual([{ feature: "sampling", policy: "degrade", detail: "from telemetry", source: "telemetry" }])
  })

  test("reads the Kiro effort level from either schema path", () => {
    expect(
      upstreamEffortLevel(
        observation({ upstreamRequestBody: JSON.stringify({ additionalModelRequestFields: { output_config: { effort: "high" } } }) }),
      ),
    ).toBe("high")
    expect(
      upstreamEffortLevel(
        observation({ upstreamRequestBody: JSON.stringify({ additionalModelRequestFields: { reasoning: { effort: "low" } } }) }),
      ),
    ).toBe("low")
    expect(upstreamEffortLevel(observation({ upstreamRequestBody: "{}" }))).toBeUndefined()
  })
})

describe("native harness assertions", () => {
  test("a declared outcome accepts a notice or a rejection naming the feature, never a silent 200", () => {
    const [declared] = nativeLiveCase("sampling-declared").assertions
    expect(declared.evaluate(observation({ clientJson: { content: [{ type: "text", text: "ok" }] } })).ok).toBe(false)
    expect(
      declared.evaluate(
        observation({ clientJson: { content: [{ type: "text", text: "[gateway] 1 …\n- sampling: temperature dropped" }] } }),
      ).ok,
    ).toBe(true)
    expect(
      declared.evaluate(
        observation({ status: 400, clientJson: { error: { message: "sampling is not supported; remove temperature" } } }),
      ).ok,
    ).toBe(true)
  })

  test("byte equality fails when no direct call was recorded and passes on identical bytes", () => {
    const [, bytes] = nativeLiveCase("passthrough-bytes").assertions
    expect(bytes.evaluate(observation({ clientBody: "a" })).ok).toBe(false)
    expect(bytes.evaluate(observation({ clientBody: "a", directUpstreamBody: "a" })).ok).toBe(true)
    expect(bytes.evaluate(observation({ clientBody: "a", directUpstreamBody: "b" })).ok).toBe(false)
  })
})

describe("native harness flags", () => {
  test("treats only the documented values as enabling", () => {
    for (const value of ["1", "true", "TRUE", "yes", "on"]) expect(isEnablingValue(value)).toBe(true)
    for (const value of [undefined, "", "0", "false", "off", "maybe"]) expect(isEnablingValue(value)).toBe(false)
  })
})

describe("native in-process gateway", () => {
  async function kiroCredentialFixture() {
    const dir = await mkdtemp(path.join(tempDir(), "native-gateway-source-"))
    tempDirs.push(dir)
    const source = path.join(dir, "kiro-auth-token.json")
    await writeTextFile(
      source,
      `${JSON.stringify({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        region: "us-east-1",
      })}\n`,
    )
    return copyNativeCredentials("kiro", { sourceAuthFile: source })
  }

  test("serves the copied credentials on an ephemeral port and records body-bearing request logs", async () => {
    const credentials = await kiroCredentialFixture()
    tempDirs.push(credentials.dir)
    globalThis.fetch = ((url: unknown) => {
      const target = String(url)
      if (target.includes("/ListAvailableModels")) return Promise.resolve(Response.json({ models: [{ modelId: "claude-sonnet-4.5" }] }))
      if (target.includes("/generateAssistantResponse")) return Promise.resolve(new Response('{"message":"nope"}', { status: 400 }))
      return Promise.resolve(Response.json({ ok: true }))
    }) as unknown as typeof fetch

    const gateway = await startNativeGateway({
      upstream: "kiro",
      flags: { NATIVE_STRICT: "1" },
      credentials,
    })

    try {
      expect(gateway.port).toBeGreaterThan(0)
      expect(gateway.authFile).toBe(credentials.authFile)
      // Flags a case declares are in effect while the gateway is running.
      expect(process.env.NATIVE_STRICT).toBe("1")
      expect(process.env.NATIVE_PASSTHROUGH).toBeUndefined()

      const response = await originalFetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(resolveNativeCaseBody(nativeLiveCase("sampling-declared"))),
      })
      await response.text()

      const entry = await gateway.waitForLog({ predicate: (log) => log.path === "/v1/messages", timeoutMs: 5000 })
      expect(entry.state).toBe("complete")
      expect(entry.requestBody).toContain("temperature")
      // The upstream body the transcript writer reads, captured through onRequestBody.
      expect(entry.proxy?.label).toContain("Kiro")
      expect(entry.proxy?.requestBody).toContain("conversationState")
    } finally {
      await gateway.stop()
    }

    // Stopping restores whatever the developer's shell had set.
    expect(process.env.NATIVE_STRICT).toBeUndefined()
  })
})

describe("native credential copier", () => {
  async function providerStateFixture() {
    const dir = await mkdtemp(path.join(tempDir(), "native-cred-source-"))
    tempDirs.push(dir)
    const source = path.join(dir, "provider-state.json")
    await writeTextFile(
      source,
      `${JSON.stringify({
        provider: "kiro",
        kiro: {
          activeAccount: "account-1",
          endpointProxy: { messages: "codex" },
          data: {
            activeAccount: "account-1",
            accounts: [
              {
                accessToken: "access",
                refreshToken: "refresh",
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
                region: "us-east-1",
                sourceAuthFile: "~/.aws/sso/cache/kiro-auth-token.json",
                sourceAccountIndex: 0,
                sourceAccountKey: "account-1",
              },
            ],
          },
        },
        codex: { data: [{ type: "oauth", access: "a", refresh: "r", expires: 1 }] },
      })}\n`,
    )
    return source
  }

  test("copies the section for the target upstream and strips every write-back link", async () => {
    const source = await providerStateFixture()
    const copy = await copyNativeCredentials("kiro", { sourceAuthFile: source })
    tempDirs.push(copy.dir)

    const copied = JSON.parse(await readTextFile(copy.authFile))
    expect(copy.authFile).toBe(path.join(copy.dir, "provider-state.json"))
    expect(copy.providerConfigPath).toBe(copy.authFile)
    expect(copied.provider).toBe("kiro")
    expect(copied.codex).toBeUndefined()
    expect(copied.kiro.endpointProxy).toBeUndefined()
    expect(copied.kiro.data.accounts[0].accessToken).toBe("access")
    for (const key of ["sourceAuthFile", "sourceAccountIndex", "sourceAccountKey"]) {
      expect(JSON.stringify(copied)).not.toContain(key)
    }
  })

  test("leaves the source file byte-for-byte untouched", async () => {
    const source = await providerStateFixture()
    const before = await credentialFingerprint(source)
    const copy = await copyNativeCredentials("kiro", { sourceAuthFile: source })
    tempDirs.push(copy.dir)
    await copy.cleanup()
    expect(await credentialFingerprint(source)).toEqual(before)
  })

  test("copies siblings for a standalone auth file and keeps the file name", async () => {
    const dir = await mkdtemp(path.join(tempDir(), "native-cred-standalone-"))
    tempDirs.push(dir)
    const source = path.join(dir, "kiro-auth-token.json")
    await writeTextFile(
      source,
      `${JSON.stringify({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        region: "us-east-1",
      })}\n`,
    )
    await writeTextFile(path.join(dir, ".account-info.json"), `${JSON.stringify({ activeAccount: "a", accounts: {} })}\n`)

    const copy = await copyNativeCredentials("kiro", { sourceAuthFile: source })
    tempDirs.push(copy.dir)
    expect(copy.authFile).toBe(path.join(copy.dir, "kiro-auth-token.json"))
    expect(copy.providerConfigPath).toBeUndefined()
    expect(JSON.parse(await readTextFile(copy.authFile)).accessToken).toBe("access")
    expect(await readTextFile(path.join(copy.dir, ".account-info.json"))).toContain("activeAccount")
  })

  test("cleanup removes the copy directory", async () => {
    const source = await providerStateFixture()
    const copy = await copyNativeCredentials("kiro", { sourceAuthFile: source })
    await copy.cleanup()
    expect(await exists(copy.dir)).toBe(false)
  })

  test("protects the Kiro token paths and reports a missing file instead of throwing", async () => {
    expect(NATIVE_PROTECTED_CREDENTIAL_FILES.some((file) => file.endsWith("kiro-auth-token.json"))).toBe(true)
    const dir = await mkdtemp(path.join(tempDir(), "native-cred-missing-"))
    tempDirs.push(dir)
    const missing = path.join(dir, "nope.json")
    expect(await credentialFingerprint(missing)).toEqual({ path: missing, exists: false })
  })
})

describe("native response capture", () => {
  function log(proxy?: RequestLogEntry["proxy"]): RequestLogEntry {
    return {
      id: "1",
      state: "complete",
      at: "now",
      method: "POST",
      path: "/v1/messages",
      status: 200,
      durationMs: 1,
      error: "-",
      requestHeaders: {},
      ...(proxy ? { proxy } : {}),
    }
  }

  function proxyLog(overrides: Partial<NonNullable<RequestLogEntry["proxy"]>> = {}): NonNullable<RequestLogEntry["proxy"]> {
    return {
      label: "Kiro messages",
      method: "POST",
      target: "upstream",
      status: 200,
      durationMs: 1,
      error: "-",
      ...overrides,
    }
  }

  test("splits SSE text into events, parsing JSON data and joining multi-line payloads", () => {
    const events = parseSseText(
      [
        "event: message_start",
        'data: {"type":"message_start"}',
        "",
        "event: content_block_delta",
        'data: {"type":"content_block_delta",',
        'data: "index":0}',
        "",
        "data: [DONE]",
        "",
      ].join("\n"),
    )

    expect(events.map((event) => event.event)).toEqual(["message_start", "content_block_delta", undefined])
    expect(events[1].data).toEqual({ type: "content_block_delta", index: 0 })
    // A non-JSON payload is kept verbatim rather than dropped.
    expect(events[2].data).toBe("[DONE]")
  })

  test("reads an SSE response into events and a JSON response into clientJson", () => {
    const sse = captureNativeObservation({
      caseId: "passthrough-off",
      response: new Response("", { headers: { "content-type": "text/event-stream" } }),
      clientBody: 'event: response.completed\ndata: {"type":"response.completed"}\n\n',
      logs: [],
    })
    expect(sse.clientJson).toBeUndefined()
    expect(eventTypes(sse)).toContain("response.completed")

    const json = captureNativeObservation({
      caseId: "sampling-declared",
      response: new Response("", { headers: { "content-type": "application/json" } }),
      clientBody: '{"content":[{"type":"text","text":"ok"}]}',
      logs: [],
    })
    expect(json.clientEvents).toEqual([])
    expect(json.clientJson?.content).toBeDefined()
  })

  test("copies the upstream capture off the request log and counts client-driven upstream calls", () => {
    const entry = log(proxyLog({ requestBody: '{"conversationState":{}}', responseBody: "raw-upstream" }))
    const observation = captureNativeObservation({
      caseId: "effort-default",
      response: new Response("", { headers: { "content-type": "application/json" } }),
      clientBody: "{}",
      logs: [log(), entry],
      requestLog: entry,
      directUpstreamBody: "direct",
    })

    expect(observation.upstreamRequestBody).toBe('{"conversationState":{}}')
    expect(observation.upstreamResponseBody).toBe("raw-upstream")
    expect(observation.directUpstreamBody).toBe("direct")
    // Two logs, one of which recorded no upstream call.
    expect(observation.upstreamRequestCount).toBe(1)
  })

  test("falls back to the last log that recorded an upstream call when none is named", () => {
    const first = log(proxyLog({ requestBody: "first" }))
    const second = log(proxyLog({ requestBody: "second" }))
    const observation = captureNativeObservation({
      caseId: "effort-default",
      response: new Response("", { headers: { "content-type": "application/json" } }),
      clientBody: "{}",
      logs: [first, second],
    })
    expect(observation.upstreamRequestBody).toBe("second")
  })

  test("records a status with neither body shape rather than throwing", () => {
    const observation = captureNativeObservation({
      caseId: "mcp-approval-reject",
      response: new Response("", { status: 400, headers: { "content-type": "text/plain" } }),
      clientBody: "not json",
      logs: [],
    })
    expect(observation.status).toBe(400)
    expect(observation.clientJson).toBeUndefined()
    expect(observation.clientBody).toBe("not json")
  })
})

describe("native matrix records", () => {
  test("reads requested features from assertion ids and skips the mention needles", () => {
    expect(nativeCaseFeatures(nativeLiveCase("no-silent-drop"))).toEqual([
      "sampling",
      "stopSequences",
      "toolChoiceForced",
      "thinkingBudget",
    ])
    expect(nativeCaseFeatures(nativeLiveCase("sampling-native"))).toEqual(["sampling"])
    // `notice-mentions-max` names a needle, not a feature.
    expect(nativeCaseFeatures(nativeLiveCase("effort-degrade"))).toEqual([])
  })

  test("records one observation per requested feature, marking whether a notice was seen", () => {
    const records = nativeMatrixObservationsFor(
      nativeLiveCase("sampling-declared"),
      observation({
        clientJson: { content: [{ type: "text", text: "[gateway] 1 …\n- sampling: temperature dropped" }] },
      }),
    )

    expect(records).toHaveLength(1)
    expect(records[0].route).toBe("/v1/messages")
    expect(records[0].upstream).toBe("kiro")
    expect(records[0].feature).toBe("sampling")
    expect(records[0].noticeObserved).toBe(true)
    expect(records[0].requested).toBe(true)
    expect(records[0].caseId).toBe("sampling-declared")
  })

  test("marks a requested feature that produced no notice as observed-without-notice", () => {
    const records = nativeMatrixObservationsFor(
      nativeLiveCase("sampling-native"),
      observation({ clientJson: { output: [{ type: "message" }] } }),
    )
    expect(records).toEqual([
      {
        route: "/v1/responses",
        upstream: "codex",
        feature: "sampling",
        noticeObserved: false,
        requested: true,
        caseId: "sampling-native",
        detail: "status 200",
      },
    ])
  })

  test("adds a record for a notice the assertions never named", () => {
    const records = nativeMatrixObservationsFor(
      nativeLiveCase("sampling-declared"),
      observation({
        clientJson: {
          content: [{ type: "text", text: "[gateway] 2 …\n- sampling: dropped\n- stopSequences: dropped" }],
        },
      }),
    )
    expect(records.map((record) => record.feature)).toEqual(["sampling", "stopSequences"])
  })

  test("writes the shape the matrix walk reads back", async () => {
    const dir = await mkdtemp(path.join(tempDir(), "native-observations-"))
    tempDirs.push(dir)
    const file = path.join(dir, "observations.json")
    const records = nativeMatrixObservationsFor(nativeLiveCase("sampling-native"), observation())

    expect(await writeNativeMatrixObservations(records, file)).toBe(file)
    const loaded = await loadNativeMatrixObservations(file)
    expect(loaded.notes).toEqual([])
    expect(loaded.observations).toEqual(records)
  })
})

describe("native case assertion evaluation", () => {
  test("collects every failing assertion with its detail instead of stopping at the first", () => {
    const failures = evaluateAssertions(nativeLiveCase("effort-default"), observation({ status: 500 }))
    expect(failures.map((failure) => failure.id)).toEqual([
      "status-200",
      "upstream-effort-present",
      "upstream-effort-in-low-medium-high-xhigh",
    ])
    expect(failures[0].detail).toContain("500")
  })

  test("reports a throwing assertion as a failure rather than propagating it", () => {
    const throwing = {
      id: "boom",
      description: "throws",
      evaluate: () => {
        throw new Error("kaboom")
      },
    }
    const failures = evaluateAssertions(
      { ...nativeLiveCase("sampling-native"), assertions: [throwing] },
      observation(),
    )
    expect(failures).toEqual([{ id: "boom", description: "throws", detail: "assertion threw: kaboom" }])
  })
})
