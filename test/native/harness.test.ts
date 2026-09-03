import { afterEach, describe, expect, test } from "bun:test"

import { readTextFile, writeTextFile } from "../../src/core/bun-fs"
import { bunPath as path, tempDir } from "../../src/core/paths"
import type { RequestLogEntry } from "../../src/core/types"
import { exists, mkdtemp, rm } from "../helpers"

import {
  KIRO_EFFORT_LEVELS,
  KIRO_OUT_OF_ENUM_EFFORT,
  NATIVE_EARLY_GREEN_OWNING_TASK,
  NATIVE_LIVE_CASES,
  NATIVE_LIVE_CASE_IDS,
  NATIVE_LIVE_GATE_HOLD_STATE,
  NATIVE_MCP_SERVER_URL_PLACEHOLDER,
  nativeBaselineCaseIds,
  nativeGateHoldStateCaseIds,
  nativeLiveCase,
  resolveNativeCaseBody,
} from "./cases"
import type { NativeLiveCaseId } from "./cases"
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
      "sampling-degrade",
      "passthrough-off",
      "messages-no-passthrough",
      "web-search-native",
    ])
    expect(nativeBaselineCaseIds("red")).toHaveLength(10)
  })

  test("records the rebaselined live-gate hold state: 14 green / 0 red, after the RR57 flip", () => {
    // Rebaselined off Run_Record 20's stale `5 green / 9 red` to `9 green / 5 red` (RR22–RR25 and
    // RR26–RR29 measured that split with zero flips between them), then to `10 green / 4 red` on
    // **Run_Record 30** when `passthrough-bytes` flipped, then to this `13 green / 1 red` on
    // **Run_Record 52**: the three effort cases each flipped red → green `3 / 0` under their own
    // gates (20.4 / 22.4 / 23.4, RR48–RR50 and re-measured RR53–RR55), and `passthrough-bytes`
    // returned to green `3 / 0` after the RR47 usage-counter narrowing. See the table's comment in
    // `cases.ts` for why a gate's hold-state clause must measure its own effect and not inherited
    // progress, and for the per-case reasons behind this snapshot.
    //
    // Rebaselined once more to this `14 green / 0 red` on **Run_Record 57**, when `no-silent-drop`
    // flipped red → green `4 / 0` under its own gate 14b.10 — the last red case of the set, and the
    // twelve-run-old pair `declared-outcome-stopSequences` / `declared-outcome-thinkingBudget`
    // closed by reporting every rejection and by deciding the deferred effort outcome before the
    // report is built. With the red list empty this clause is at its strictest: a red anywhere is a
    // failure with nothing left to inherit.
    expect(nativeGateHoldStateCaseIds("green")).toEqual([
      "sampling-declared",
      "sampling-degrade",
      "effort-default",
      "effort-degrade",
      "thinking-budget",
      "passthrough-bytes",
      "passthrough-off",
      "messages-no-passthrough",
      "web-search-native",
      "web-search-no-heuristic",
      "web-fetch-emulate",
      "mcp-toolset-kiro",
      "mcp-approval-reject",
      "no-silent-drop",
    ])
    // Empty, and that is the point: every one of the fourteen cases is measured green, so no gate
    // has a red state to hold and none can pass by inheriting one.
    expect(nativeGateHoldStateCaseIds("red")).toEqual([])
    // Every case is in exactly one of the two lists, so the clause stays exact over all fourteen.
    expect(nativeGateHoldStateCaseIds("green").length + nativeGateHoldStateCaseIds("red").length).toBe(
      NATIVE_LIVE_CASE_IDS.length,
    )
  })

  test("each early-green case is named with the task that turned it green", () => {
    // These four went green ahead of their own gates because their implementing code landed early.
    // Their own gates must read them as already green at gate start, not as their own target flip.
    expect(NATIVE_EARLY_GREEN_OWNING_TASK).toEqual({
      "web-search-no-heuristic": "27",
      "web-fetch-emulate": "28",
      "mcp-toolset-kiro": "35",
      "mcp-approval-reject": "36",
    })
    for (const id of Object.keys(NATIVE_EARLY_GREEN_OWNING_TASK) as NativeLiveCaseId[]) {
      expect(nativeLiveCase(id).baseline).toBe("red")
      expect(NATIVE_LIVE_GATE_HOLD_STATE[id]).toBe("green")
    }
  })

  test("the effort-degrade case requests a level outside the enum by construction", () => {
    // Coordination without editing the descriptor source: whatever ends up supplying the Kiro
    // effort enum, `effort-degrade` keeps requesting a value that enum does not contain, so the
    // case returns to its titled `effort_not_in_enum` branch with no edit to the registry.
    expect(KIRO_EFFORT_LEVELS).not.toContain(KIRO_OUT_OF_ENUM_EFFORT as never)
    expect(JSON.stringify(nativeLiveCase("effort-degrade").body)).toContain(`"effort":"${KIRO_OUT_OF_ENUM_EFFORT}"`)
    expect(nativeLiveCase("effort-degrade").title).toContain("effort_not_in_enum")
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

  test("the exact half compares client bytes against the upstream bytes the gateway captured", () => {
    const [, captured] = nativeLiveCase("passthrough-bytes").assertions
    const sse = 'event: response.completed\ndata: {"type":"response.completed","id":"resp_a"}\n\n'
    expect(captured.evaluate(observation({ clientBody: sse })).ok).toBe(false)
    expect(captured.evaluate(observation({ clientBody: sse, upstreamResponseBody: sse })).ok).toBe(true)
    expect(captured.evaluate(observation({ clientBody: sse, upstreamResponseBody: `${sse}${sse}` })).ok).toBe(false)
  })

  test("the direct-call half normalizes only volatile fields and fails on any other divergence", () => {
    const [, , direct] = nativeLiveCase("passthrough-bytes").assertions
    // Ids are spelled at their measured shape (prefix plus a long hex run) because RR20 moved them
    // out of the key-name list and into a shape rule; a short `resp_a` is not an id to this diff.
    const idA = "resp_03d2297e550c650f016a97d7863ae087d091245f14"
    const idB = "resp_06ab00305d422374016a97d855c52c87d0adc4751f"
    const idC = "resp_0c1c80937aea6d70016a97d8f689a487d0977789e3"
    const frame = (id: string, delta: string, event = "response.output_text.delta") =>
      `event: ${event}\ndata: {"type":"${event}","id":"${id}","created_at":1,"obfuscation":"${id}","delta":"${delta}"}\n\n`
    const client = frame(idA, "hi")

    expect(direct.evaluate(observation({ clientBody: client })).ok).toBe(false)
    // Volatile fields differ, everything else matches: this is the passing shape.
    expect(direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame(idB, "hi") })).ok).toBe(true)
    // A non-volatile payload value differs.
    expect(direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame(idB, "bye") })).ok).toBe(false)
    // A frame the client never received.
    expect(
      direct.evaluate(observation({ clientBody: client, directUpstreamBody: `${client}${frame(idC, "hi")}` })).ok,
    ).toBe(false)
    // Same payload values, different event name and type.
    expect(
      direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame(idB, "hi", "response.completed") })).ok,
    ).toBe(false)
  })

  // RR20: ids are normalized by shape and labelled by first occurrence, not blanked by key name.
  // These four cases pin what that buys — an id-only divergence is tolerated, a *re-minted* id is
  // not — which is exactly the distinction adding `item_id` to the name list would have destroyed.
  test("the direct-call half tolerates fresh ids but fails on an id the gateway re-minted", () => {
    const [, , direct] = nativeLiveCase("passthrough-bytes").assertions
    // Two frames referencing one item id under two different keys, the shape RR20 measured:
    // `item.id` on `output_item.added`, `item_id` on the content frame that follows it.
    const body = (itemId: string, referencedId: string, delta = "ok") =>
      [
        `event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"${itemId}","type":"message"},"output_index":1}`,
        `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"${referencedId}","delta":"${delta}","obfuscation":"pad"}`,
      ].join("\n\n")

    const a = "msg_03d2297e550c650f016a97d7863ae087d091245f144d2dd78a"
    const b = "msg_06ab00305d422374016a97d855c52c87d0adc4751fa84fb5cf"
    const c = "msg_0c1c80937aea6d70016a97d8f689a487d0977789e307c8edda"

    // Both bodies internally consistent, only the id values differ: the passing shape.
    expect(direct.evaluate(observation({ clientBody: body(a, a), directUpstreamBody: body(b, b) })).ok).toBe(true)
    // The client's content frame references an id its own `output_item.added` never announced —
    // a re-minted id. Values still look per-call, but the relationship diverges.
    expect(direct.evaluate(observation({ clientBody: body(a, c), directUpstreamBody: body(b, b) })).ok).toBe(false)
    // …and in the other direction, so the check is not one-sided.
    expect(direct.evaluate(observation({ clientBody: body(a, a), directUpstreamBody: body(b, c) })).ok).toBe(false)
    // A non-id payload change still fails even when every id is consistent.
    expect(direct.evaluate(observation({ clientBody: body(a, a), directUpstreamBody: body(b, b, "bye") })).ok).toBe(false)
    // Framing still fails: one extra frame, same ids.
    expect(
      direct.evaluate(observation({ clientBody: body(a, a), directUpstreamBody: `${body(b, b)}\n\n${body(b, b)}` })).ok,
    ).toBe(false)
  })

  test("the direct-call half labels ids used as object keys from the same mapping as values", () => {
    const [, , direct] = nativeLiveCase("passthrough-bytes").assertions
    // `usage.attribution.items` is keyed by item id — a place a key-name list cannot reach at all.
    const body = (keyId: string, referencedId: string) =>
      `event: response.completed\ndata: {"type":"response.completed","response":{"id":"${referencedId}","usage":{"attribution":{"items":{"${keyId}":{"output_tokens":7}}}}}}`

    const a = "rs_03d2297e550c650f016a97d786c34c87d0899a2a33b26614bc"
    const b = "rs_02c24f027f03594a016a98ef87011887d08b6794a318358bc5"
    const c = "rs_06ab00305d422374016a97d856b1d487d0ae44ec80246c033a"

    expect(direct.evaluate(observation({ clientBody: body(a, a), directUpstreamBody: body(b, b) })).ok).toBe(true)
    expect(direct.evaluate(observation({ clientBody: body(a, c), directUpstreamBody: body(b, b) })).ok).toBe(false)
  })

  // RR22 and RR26 measured `completed_at` — on two different Codex models — as the one remaining
  // divergence after the RR20 id repair, so it joined `PASSTHROUGH_VOLATILE_FIELDS`. The second
  // half of this test is the half that matters: a volatile list that also swallows real differences
  // is worse than no list, so the same frame shape is checked to still fail on a neighbouring
  // non-volatile scalar and on a clock-looking field that is *not* listed.
  test("the direct-call half tolerates a differing completed_at but not a neighbouring non-volatile field", () => {
    const [, , direct] = nativeLiveCase("passthrough-bytes").assertions
    const frame = (overrides: Record<string, unknown>) =>
      `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_03d2297e550c650f016a97d7863ae087d091245f14",
          created_at: 1788433390,
          completed_at: 1788433394,
          status: "completed",
          queued_at: 1788433389,
          max_output_tokens: 4096,
          usage: { output_tokens: 7 },
          ...overrides,
        },
      })}\n\n`
    const client = frame({})

    // The measured shape: `completed_at` two seconds later on the direct call, everything else equal.
    expect(direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame({ completed_at: 1788433396 }) })).ok).toBe(
      true,
    )
    // A non-volatile scalar sitting right beside it still fails, and the failure names the field.
    const statusDiff = direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame({ status: "incomplete" }) }))
    expect(statusDiff.ok).toBe(false)
    expect(statusDiff.ok ? "" : statusDiff.detail).toContain("incomplete")
    // A counter differing still fails: blanking a timestamp must not blank numbers generally.
    //
    // This used to read the `usage.output_tokens` counter. RR47 narrowed the diff to tolerate
    // numbers inside a `usage` subtree, so the check moved to `max_output_tokens` — a counter on the
    // response, outside `usage` — rather than being deleted. Same guarantee, measured somewhere the
    // RR47 narrowing does not reach; the `usage` side of that narrowing is pinned in its own test
    // below, on both halves.
    expect(
      direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame({ max_output_tokens: 8192 }) })).ok,
    ).toBe(false)
    // A clock-shaped field that is *not* on the list is not absorbed by the list either.
    expect(direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame({ queued_at: 1788433391 }) })).ok).toBe(
      false,
    )
    // And the list is keyed by name, not by value: the same number under an unlisted key still fails.
    expect(
      direct.evaluate(observation({ clientBody: client, directUpstreamBody: frame({ queued_at: 1788433394 }) })).ok,
    ).toBe(false)
  })

  // RR47 measured `bytes-match-direct-call-modulo-volatile-fields` failing twice at offset 5510 on
  // `usage.attribution.items[<id>].output_tokens` — 28 vs 19, then 23 vs 16 — while
  // `client-bytes-equal-captured-upstream-bytes` passed both times. Two independent generations
  // cannot report the same token counts, so numbers under a `usage` subtree are tolerated. The
  // second half of this test is what makes the first half safe: everything the assertion is really
  // for must still fail, or the narrowing would hide a gateway that truncates or rewrites content.
  test("the direct-call half tolerates a differing usage counter but nothing else", () => {
    const [, , direct] = nativeLiveCase("passthrough-bytes").assertions
    const itemA = "msg_03d2297e550c650f016a97d7863ae087d091245f144d2dd78a"
    const itemB = "msg_06ab00305d422374016a97d855c52c87d0adc4751fa84fb5cf"
    const itemC = "msg_0c1c80937aea6d70016a97d8f689a487d0977789e307c8edda"

    // The measured shape: `usage.attribution.items` keyed by item id, the counter three levels below
    // the `usage` key, plus a top-level usage counter, a non-`usage` counter, a status, and a text
    // payload — so one fixture carries every half this test checks.
    const body = (options: {
      item?: string
      referenced?: string
      attributed?: number
      outputTokens?: number
      maxOutputTokens?: number
      status?: string
      delta?: string
      extraFrame?: boolean
    } = {}) => {
      const item = options.item ?? itemA
      const completed = `event: response.completed\ndata: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: "resp_03d2297e550c650f016a97d7863ae087d091245f14",
          status: options.status ?? "completed",
          max_output_tokens: options.maxOutputTokens ?? 4096,
          usage: {
            output_tokens: options.outputTokens ?? 7,
            attribution: { items: { [item]: { output_tokens: options.attributed ?? 28 } } },
          },
        },
      })}`
      const delta = `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        item_id: options.referenced ?? item,
        delta: options.delta ?? "ok",
      })}`
      return [delta, completed, ...(options.extraFrame === true ? [delta] : [])].join("\n\n")
    }

    const client = body()

    // Half one — the RR47 shape passes. Fresh ids, and every `usage` counter different, including
    // the exact field and the exact pair of numbers RR47 measured on the second re-measure.
    expect(
      direct.evaluate(
        observation({
          clientBody: client,
          directUpstreamBody: body({ item: itemB, attributed: 19, outputTokens: 5 }),
        }),
      ).ok,
    ).toBe(true)

    // Half two — the guarantees the narrowing must not touch. Each of these differs from `client` in
    // exactly one place, and each must still fail.
    const mustFail: Record<string, ReturnType<typeof body>> = {
      // A counter *outside* `usage`: the narrowing is by region, so this is still a real difference.
      "a non-usage counter": body({ maxOutputTokens: 8192 }),
      // A differing status.
      "a differing status": body({ status: "incomplete" }),
      // A differing text payload — the truncate/rewrite case the narrowing exists to keep catching.
      "a differing text payload": body({ delta: "bye" }),
      // An extra frame.
      "an extra frame": body({ extraFrame: true }),
      // A re-minted id: the content frame references an id no frame announced.
      "a re-minted id": body({ item: itemB, referenced: itemC }),
    }
    for (const [what, directUpstreamBody] of Object.entries(mustFail)) {
      expect(direct.evaluate(observation({ clientBody: client, directUpstreamBody })).ok, what).toBe(false)
    }

    // Keys inside `usage` are not tolerated either — only the numbers are — so a dropped usage field
    // still fails. Without this, "tolerate numbers under usage" could be read as "ignore usage".
    const dropped = `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","item_id":"${itemB}","delta":"ok"}\n\nevent: response.completed\ndata: ${JSON.stringify(
      {
        type: "response.completed",
        response: {
          id: "resp_03d2297e550c650f016a97d7863ae087d091245f14",
          status: "completed",
          max_output_tokens: 4096,
          usage: { attribution: { items: { [itemB]: { output_tokens: 19 } } } },
        },
      },
    )}`
    expect(direct.evaluate(observation({ clientBody: client, directUpstreamBody: dropped })).ok).toBe(false)
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

    // ## Why this test declares `NATIVE_MCP_EMULATION` and drives `web-search-native`
    //
    // Its subject is the log capture: the inbound body on the entry, and the **upstream** body the
    // transcript writer reads through `onRequestBody`. That last assertion only means anything on a
    // request that reaches the Kiro payload builder, and as of task 14.2 the Claude mapper populates
    // canonical `sampling`, which puts two Kiro rejections in the way of the pair this test used
    // to send:
    //
    //  - `sampling-declared` sends `temperature` and `top_p`, so Kiro's declared `sampling: "reject"`
    //    now returns a 400 before any payload exists. That is the flip task 14.5 predicts, and it is
    //    asserted where it belongs — in the feature-resolution tests, not here.
    //  - `NATIVE_STRICT` escalates `degrade → reject`, and Kiro declares `outputLength: "degrade"`,
    //    so under strict *every* Claude request 400s on the mandatory `max_tokens` alone. Task 12b
    //    recorded that reading openly and deliberately did not decide it
    //    (`test/upstream/output-length.property.test.ts`); this test must not encode a decision
    //    either, so it declares a flag whose meaning is orthogonal to feature policy.
    //
    // Nothing about the flag plumbing is specific to which flag is named — `startNativeGateway()`
    // walks `NATIVE_FLAG_NAMES` — and `NATIVE_STRICT` keeps its own coverage in
    // `test/app/native-strict-wiring.test.ts` and `test/core/strict.property.test.ts`.
    const gateway = await startNativeGateway({
      upstream: "kiro",
      flags: { NATIVE_MCP_EMULATION: "1" },
      credentials,
    })

    try {
      expect(gateway.port).toBeGreaterThan(0)
      expect(gateway.authFile).toBe(credentials.authFile)
      // Flags a case declares are in effect while the gateway is running.
      expect(process.env.NATIVE_MCP_EMULATION).toBe("1")
      expect(process.env.NATIVE_PASSTHROUGH).toBeUndefined()
      expect(process.env.NATIVE_STRICT).toBeUndefined()

      const response = await originalFetch(`${gateway.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(resolveNativeCaseBody(nativeLiveCase("web-search-native"))),
      })
      await response.text()

      const entry = await gateway.waitForLog({ predicate: (log) => log.path === "/v1/messages", timeoutMs: 5000 })
      expect(entry.state).toBe("complete")
      expect(entry.requestBody).toContain("max_tokens")
      // The upstream body the transcript writer reads, captured through onRequestBody.
      expect(entry.proxy?.label).toContain("Kiro")
      expect(entry.proxy?.requestBody).toContain("conversationState")
    } finally {
      await gateway.stop()
    }

    // Stopping restores whatever the developer's shell had set.
    expect(process.env.NATIVE_MCP_EMULATION).toBeUndefined()
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
    expect(nativeCaseFeatures(nativeLiveCase("sampling-degrade"))).toEqual(["sampling"])
    // `notice-mentions-<KIRO_OUT_OF_ENUM_EFFORT>` names a needle, not a feature.
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
      nativeLiveCase("sampling-degrade"),
      observation({ clientJson: { output: [{ type: "message" }] } }),
    )
    expect(records).toEqual([
      {
        route: "/v1/responses",
        upstream: "codex",
        feature: "sampling",
        noticeObserved: false,
        requested: true,
        caseId: "sampling-degrade",
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
    const records = nativeMatrixObservationsFor(nativeLiveCase("sampling-degrade"), observation())

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
      // Derived from `KIRO_EFFORT_LEVELS` rather than spelled out, because that list tracks the
      // enum `NATIVE_KIRO_MODEL` publishes and moved with the model (`…-xhigh` → `…-xhigh-max`).
      // The assertion is unchanged in strength: still all three failures, still in order, still by
      // exact id — only the id's derivation stops being a copy of a value that has one source.
      `upstream-effort-in-${KIRO_EFFORT_LEVELS.join("-")}`,
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
      { ...nativeLiveCase("sampling-degrade"), assertions: [throwing] },
      observation(),
    )
    expect(failures).toEqual([{ id: "boom", description: "throws", detail: "assertion threw: kaboom" }])
  })
})
