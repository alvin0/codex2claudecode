// Feature: native-api-mode — the paginated model catalog, and the fallback merge as invariants.
//
// The measured live `ListAvailableModels` response carries `defaultModel, models, nextToken` with 20
// entries on page one, and the client read only that page: a model on page two was invisible to the
// registry entirely. Pagination is therefore not a nicety here, it is a correctness fix about a
// catalog that changes over time — so the properties below are stated over an arbitrary number of
// arbitrary pages rather than over one hand-written pair.
//
// Two properties, plus the unit cases a reader can check by eye:
//
//  A. **Every entry of every page reached the merged body, in order** — the walk loses nothing and
//     invents nothing, and the merged body carries no cursor.
//  B. **The static fallback only ever adds, and only where live was silent** — for any mix of live
//     entries, a live enum survives byte-for-byte and is marked `live`; a **silence** (no
//     `additionalModelRequestFieldsSchema` key) is filled from the bundled file and marked `static`;
//     an **answer** that published no effort enum (the measured `null`) is a denial and yields no
//     descriptor at all, however much the bundled file claims to know about that model id. And every
//     descriptor's `defaultLevel` is a member of its own `levels`, whichever source produced it.

import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { Kiro_Auth_Manager } from "../../../src/upstream/kiro/auth"
import { Kiro_Client, LIST_AVAILABLE_MODELS_MAX_PAGES } from "../../../src/upstream/kiro/client"
import { KiroModelMetadataRegistry } from "../../../src/upstream/kiro/model-metadata"
import { staticKiroEffortDescriptor } from "../../../src/upstream/kiro/static-models"

function auth() {
  return new Kiro_Auth_Manager({
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
  } as never, "/tmp/unused")
}

interface PagedFetch {
  client: Kiro_Client
  /** The `nextToken` query value of each request, in order. `undefined` for the first page. */
  tokens: (string | undefined)[]
}

/**
 * A client whose model-catalog endpoint serves `pages` in order, handing out a cursor for each page
 * but the last. Only the transport is faked; the cursor walk under test is the real one.
 */
function pagedClient(pages: Record<string, unknown>[], options: { failAfter?: number; repeatToken?: boolean } = {}): PagedFetch {
  const tokens: (string | undefined)[] = []
  const client = new Kiro_Client(auth(), {
    fetch: ((input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input))
      const token = url.searchParams.get("nextToken") ?? undefined
      tokens.push(token)
      const index = token === undefined ? 0 : Number(token.replace("page-", ""))
      if (options.failAfter !== undefined && index > options.failAfter) return Promise.resolve(new Response("nope", { status: 400 }))
      const page = pages[index]
      if (!page) return Promise.resolve(Response.json({}))
      const last = index === pages.length - 1
      const nextToken = options.repeatToken ? token ?? "page-1" : last ? undefined : `page-${index + 1}`
      return Promise.resolve(Response.json({ ...page, ...(nextToken ? { nextToken } : {}) }))
    }) as unknown as typeof fetch,
  })
  return { client, tokens }
}

function mergedModels(body: unknown): unknown[] {
  const models = (body as { models?: unknown } | undefined)?.models
  return Array.isArray(models) ? models : []
}

describe("Feature: native-api-mode, the Kiro model catalog is read to completion", () => {
  test("Property: every entry of every page lands in the merged body, in page order, with no cursor left", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.array(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 0, maxLength: 4 }), { minLength: 1, maxLength: 6 }),
      async (pageIds) => {
        const pages = pageIds.map((ids, index) => ({
          ...(index === 0 ? { defaultModel: { modelId: "default-model" } } : {}),
          models: ids.map((id, position) => ({ modelId: `${id}-${index}-${position}` })),
        }))
        const { client, tokens } = pagedClient(pages)

        const body = await client.listAvailableModelsFull()

        const expected = pages.flatMap((page) => page.models.map((model) => model.modelId))
        expect(mergedModels(body).map((model) => (model as { modelId: string }).modelId)).toEqual(expected)
        // Page one's own fields survive, and the cursor does not: a merged body has no meaningful
        // position in a walk that already finished.
        expect((body as { defaultModel?: unknown }).defaultModel).toEqual({ modelId: "default-model" })
        expect((body as { nextToken?: unknown }).nextToken).toBe(undefined)
        expect((body as { modelPagination?: unknown }).modelPagination)
          .toEqual({ pages: pages.length, capReached: false, maxPages: LIST_AVAILABLE_MODELS_MAX_PAGES })
        // One request per page, and the cursor of each request is the previous page's token.
        expect(tokens).toEqual(pages.map((_, index) => (index === 0 ? undefined : `page-${index}`)))
      },
    ), { numRuns: 40 })
  })

  test("Property: the static fallback only adds where live was silent — an enum survives, a denial stands", () => {
    fc.assert(fc.property(
      fc.array(fc.record({
        // Two ids the bundled file has a descriptor for, and two it does not, so "the file knows this
        // model" and "the file does not" are both generated for every disclosure state below.
        modelId: fc.constantFrom("claude-sonnet-4.5", "claude-opus-4.5", "deepseek-3.2", "custom-model"),
        // The three disclosure states, as the wire expresses them:
        //   an enum   — the endpoint published a vocabulary,
        //   `null`    — the key present and explicitly empty: an answer, and therefore a denial,
        //   `absent`  — the key missing entirely: silence, and therefore a gap to fill.
        live: fc.oneof(
          fc.record({
            schemaPath: fc.constantFrom("output_config" as const, "reasoning" as const),
            levels: fc.uniqueArray(fc.constantFrom("low", "medium", "high", "xhigh", "max"), { minLength: 1 }),
          }),
          fc.constant("null" as const),
          fc.constant("absent" as const),
        ),
      }), { minLength: 1, maxLength: 6 }),
      (entries) => {
        const registry = new KiroModelMetadataRegistry()
        registry.populate({
          models: entries.map((entry) => ({
            modelId: entry.modelId,
            ...(entry.live === "absent"
              ? {}
              : {
                  additionalModelRequestFieldsSchema: entry.live === "null"
                    ? null
                    : { properties: { [entry.live.schemaPath]: { properties: { effort: { enum: entry.live.levels } } } } },
                }),
          })),
        })

        // A duplicate id keeps the last entry, matching `Map.set`, so compare against that.
        const lastByModel = new Map(entries.map((entry) => [entry.modelId, entry]))
        for (const [modelId, entry] of lastByModel) {
          const effort = registry.get(modelId)?.effort
          if (typeof entry.live === "object") {
            // Live wins, unchanged, and says so.
            expect(effort).toEqual({ schemaPath: entry.live.schemaPath, levels: entry.live.levels, provenance: "live" })
            expect(registry.get(modelId)?.effortSchemaDisclosure).toBe("answered")
          } else if (entry.live === "null") {
            // A denial stands. Nothing — not even for a model id the bundled file has an opinion
            // about, which is the whole regression this arm exists to catch.
            expect(effort).toBeUndefined()
            expect(registry.get(modelId)?.effortSchemaDisclosure).toBe("answered")
          } else {
            // Gap: exactly the static descriptor, or nothing when the file knows no such model.
            expect(effort).toEqual(staticKiroEffortDescriptor(modelId))
            expect(registry.get(modelId)?.effortSchemaDisclosure).toBe("silent")
          }
          // Containment holds whichever source produced the descriptor.
          if (effort?.defaultLevel !== undefined) expect(effort.levels).toContain(effort.defaultLevel)
          if (effort) expect(effort.levels.length).toBeGreaterThan(0)
        }
      },
    ), { numRuns: 100 })
  })

  test("stops at the page cap and reports it, rather than following a cursor forever", async () => {
    // Every page hands out a token, so only the cap can end this walk.
    const pages = Array.from({ length: LIST_AVAILABLE_MODELS_MAX_PAGES + 5 }, (_, index) => ({ models: [{ modelId: `m-${index}` }] }))
    const { client, tokens } = pagedClient(pages)

    const body = await client.listAvailableModelsFull()

    expect(tokens).toHaveLength(LIST_AVAILABLE_MODELS_MAX_PAGES)
    expect(mergedModels(body)).toHaveLength(LIST_AVAILABLE_MODELS_MAX_PAGES)
    expect((body as { modelPagination?: unknown }).modelPagination)
      .toEqual({ pages: LIST_AVAILABLE_MODELS_MAX_PAGES, capReached: true, maxPages: LIST_AVAILABLE_MODELS_MAX_PAGES })
  })

  test("a cursor that repeats itself ends the walk instead of looping", async () => {
    const { client, tokens } = pagedClient([{ models: [{ modelId: "a" }] }, { models: [{ modelId: "b" }] }], { repeatToken: true })

    const body = await client.listAvailableModelsFull()

    // Page one, then the page its token pointed at, then stop: the same token twice is not progress.
    expect(tokens).toEqual([undefined, "page-1"])
    expect(mergedModels(body).map((model) => (model as { modelId: string }).modelId)).toEqual(["a", "b"])
  })

  test("a later page that fails keeps the pages already collected", async () => {
    const { client } = pagedClient(
      [{ models: [{ modelId: "a" }] }, { models: [{ modelId: "b" }] }, { models: [{ modelId: "c" }] }],
      { failAfter: 1 },
    )

    const body = await client.listAvailableModelsFull()

    // Page 2 errors; the call still answers with pages 0 and 1 rather than throwing away a result
    // the caller could use — and rather than throwing at all.
    expect(mergedModels(body).map((model) => (model as { modelId: string }).modelId)).toEqual(["a", "b"])
    expect((body as { modelPagination?: { pages: number } }).modelPagination?.pages).toBe(2)
  })

  test("an unpaginated response is unchanged apart from the walk report", async () => {
    const { client, tokens } = pagedClient([{ models: [{ modelId: "only" }], defaultModel: { modelId: "only" } }])

    const body = await client.listAvailableModelsFull()

    expect(tokens).toEqual([undefined])
    expect(body).toEqual({
      models: [{ modelId: "only" }],
      defaultModel: { modelId: "only" },
      modelPagination: { pages: 1, capReached: false, maxPages: LIST_AVAILABLE_MODELS_MAX_PAGES },
    })
  })

  test("a first page that is not JSON still answers undefined, as before", async () => {
    const client = new Kiro_Client(auth(), {
      fetch: (() => Promise.resolve(new Response("not json"))) as unknown as typeof fetch,
    })

    expect(await client.listAvailableModelsFull()).toBeUndefined()
  })
})
