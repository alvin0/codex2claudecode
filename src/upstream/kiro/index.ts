import type { Canonical_ErrorResponse, Canonical_Request, Canonical_Response, Canonical_StreamResponse } from "../../core/canonical"
import { responseHeaders } from "../../core/http"
import type { UpstreamResult, Upstream_Provider } from "../../core/interfaces"
import { withChunkCallback } from "../../core/stream-utils"
import type { JsonObject, RequestOptions } from "../../core/types"
import { KIRO_CAPABILITIES } from "./capabilities"
import { HIDDEN_KIRO_MODELS, MODEL_CACHE_TTL_SECONDS } from "./constants"
import { publicHttpErrorBody } from "./errors"
import { Kiro_Auth_Manager, type KiroAuthManagerOptions } from "./auth"
import { Kiro_Client } from "./client"
import type { FeatureDecisions } from "../../core/feature-decisions"
import { isFeatureRejection } from "../../core/feature-policy"
import { withKiroFeatureNotices } from "./feature-notices"
import { resolveKiroFeatures } from "./features"
import { resolveKiroHostedTools } from "./hosted-tools"
import type { EffortValidation } from "./effort"
import { requestStatesEffortIntent, selectEffortLevel, validateKiroEffort } from "./effort"
import { kiroWebSearchTool, webSearchBlocks } from "./web-search"
import { KIRO_WEB_FETCH_TOOL_NAME, executeKiroWebFetch, kiroWebFetchTool } from "./web-fetch"
import { createKiroMcpSession, requestDeclaresMcpToolsets, type KiroMcpSession } from "./mcp-toolset"
import type { KiroServerToolBundle } from "./parse"
import { convertCanonicalToKiroPayload, trimNoticeText } from "./payload"
import { collectKiroResponse, streamKiroResponse } from "./parse"
import { FirstTokenTimeoutError, streamWithFirstTokenRetry } from "./stream-retry"
import { KiroHttpError, KiroMcpError, KiroNetworkError, PayloadTooLargeError, ToolNameTooLongError } from "./types"
import type { KiroEffortSelection } from "./types"
import { KiroModelMetadataRegistry } from "./model-metadata"
import type { KiroModelEffortMetadata } from "./model-metadata"

interface KiroClientOptions extends KiroAuthManagerOptions {
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  apiRegion?: string
}

export class Kiro_Upstream_Provider implements Upstream_Provider {
  readonly providerKind = "kiro" as const

  private readonly auth: Kiro_Auth_Manager
  private readonly client: Kiro_Client
  /**
   * Whether a `degrade` outcome escalates to a 400. Held, never read here: it is handed to
   * `FeatureDecisions`, which hands it to the one function that interprets it. Defaults to the
   * current behavior, so construction sites that say nothing keep getting notices rather than
   * rejections until `NATIVE_STRICT` is wired through bootstrap.
   */
  private readonly strict: boolean
  /**
   * Whether the pre-native-mode web-search *guessing* paths run — `KIRO_WEB_SEARCH_HEURISTICS`,
   * resolved by `readNativeFlags()` and threaded in as a parameter, never read from the
   * environment here (design decision D3). Defaults to **off**, which is the native-mode
   * behavior: the gateway stops inferring intent from prompt text (Requirements 17.3, 17.4).
   *
   * What it gates, and nothing else:
   *
   * - the `hasExplicitWebSearchIntent()` preflight — a `/mcp` `web_search` call issued *before*
   *   the model has asked for one, purely because the prompt held a URL or an intent phrase;
   * - the three synthesizers — `clientWebSearchToolCall()`,
   *   `clientAllowedDirectoriesToolCall()`, and therefore `clientToolCallResponse()`, which
   *   fabricate a client tool call the model never emitted.
   *
   * What it does **not** gate: the model-emitted interception path through
   * `maybeHandleKiroServerTool()`, which stays active in both flag states. That is the whole
   * distinction — a `web_search` the model actually emitted is a real request and is still
   * executed and rendered as server-tool blocks (Requirements 17.6, 17.7). The `web_search`
   * declaration itself is likewise unconditional, since a tool the model is never offered is a
   * tool it can never emit.
   *
   * Native_Mode itself has no flag: feature notices and the no-silent-drop behavior are
   * unconditional in both states.
   */
  private readonly webSearchHeuristics: boolean
  /**
   * Whether this provider may emulate a client-declared MCP toolset — `NATIVE_MCP_EMULATION`,
   * resolved by `readNativeFlags()` and threaded in as a parameter, never read from the environment
   * here (design decision D3), exactly as `strict` and `webSearchHeuristics` are.
   *
   * Defaults to **off**, and off means the pre-flag behavior survives intact: an MCP-bearing request
   * gets the same 400 it gets today, naming the same alternative (Requirement 22.5). That is why the
   * gate lives at this call site rather than in `./capabilities.ts` — the declared cell is
   * `mcpToolset: "emulate"` because the *endpoint* has no toolset field and the gateway *can* stand
   * in for one, which is a measured fact about the wire and does not change when an operator flips a
   * flag. What the flag decides is whether this build is allowed to act on it.
   *
   * Both conditions must hold, and they are different questions: the declaration says the capability
   * exists, the flag says it is switched on. Either one alone taking the emulation path would either
   * ignore a measurement or ignore the operator.
   */
  private readonly mcpEmulation: boolean
  private modelCache?: { models: string[]; cachedAt: number }
  readonly modelMetadata = new KiroModelMetadataRegistry()

  constructor(options: { auth: Kiro_Auth_Manager; client?: Kiro_Client; strict?: boolean; webSearchHeuristics?: boolean; mcpEmulation?: boolean }) {
    this.auth = options.auth
    this.client = options.client ?? new Kiro_Client(this.auth)
    this.strict = options.strict ?? false
    this.webSearchHeuristics = options.webSearchHeuristics ?? false
    this.mcpEmulation = options.mcpEmulation ?? false
  }

  /**
   * `strict`, `webSearchHeuristics`, and `mcpEmulation` ride on the same options bag as the auth and
   * client settings so the app-level composition root can hand them over in one call, and are
   * forwarded to the constructor rather than to the client: `Kiro_Client` reads only the fields it
   * knows and ignores these three. Omitting them keeps the default-off behavior (design decision
   * D3).
   */
  static async fromAuthFile(path?: string, options?: KiroClientOptions & { strict?: boolean; webSearchHeuristics?: boolean; mcpEmulation?: boolean }) {
    const auth = await Kiro_Auth_Manager.fromAuthFile(path, options)
    return new Kiro_Upstream_Provider({
      auth,
      client: new Kiro_Client(auth, options),
      strict: options?.strict,
      webSearchHeuristics: options?.webSearchHeuristics,
      mcpEmulation: options?.mcpEmulation,
    })
  }

  /**
   * Whether this request may take the MCP emulation path.
   *
   * The conjunction of the declared capability and the operator's flag, in one place, so no call
   * site re-derives it. Reads the declared cell rather than a policy literal branch: the comparison
   * is against the one value that means "the gateway stands in for this", and the value itself lives
   * in `./capabilities.ts`.
   */
  private mcpEmulationEnabled() {
    return this.mcpEmulation && KIRO_CAPABILITIES.features.mcpToolset === "emulate"
  }

  /**
   * Resolve the declared matrix for this request, then run it.
   *
   * Split into a decision half and an execution half so every result-producing path picks up
   * the notices, without a `withKiroFeatureNotices()` call sprinkled over each of the several
   * returns inside {@link Kiro_Upstream_Provider.generate} — including the synthesized
   * client-tool-call responses and the web-search preflight stream, which produce content
   * without reaching the tail of that method.
   *
   * Hosted tools are resolved from the declared matrix by `resolveKiroHostedTools()`, on the same
   * {@link FeatureDecisions} the request-shaped features used, so a refused hosted tool still
   * reports every other decision the request made. That replaced `validateUnsupportedServerTools()`,
   * which compared two type names against hardcoded strings and said nothing whatever about the
   * other eight — an `image_generation` or `code_interpreter` tool used to travel to an endpoint
   * that has no such tool and was never mentioned to the client.
   *
   * One thing the matrix cannot express, and so lives here: the MCP flag gate. The declared cell is
   * `emulate` because the gateway *can* stand in for a toolset, but a build with
   * `NATIVE_MCP_EMULATION` off must keep returning the 400 it returns today (Requirement 22.5).
   * The gate runs **before** hosted-tool resolution rather than after, because the notice that cell
   * produces says the gateway runs the tool on the request's behalf — true when the flag is on,
   * and a false statement to pair with a 400 when it is off.
   *
   * Then: one rejection means one 400 and no upstream call, which is the point of resolving
   * everything before doing any work. The notices ride along either way — the rejection return
   * goes through `withKiroFeatureNotices()` too, so a refused request still reports every other
   * decision it made.
   *
   * Two things make that report *complete* rather than "complete as far as the bail point":
   *
   * - The message comes from `rejectionReport()` rather than `firstRejection()`, so a request
   *   carrying `temperature` **and** `stop_sequences` — two `reject` cells — is told about both in
   *   one 400 instead of naming `sampling` and leaving `stopSequences` to be discovered on the
   *   retry. Which feature *caused* the 400 is unchanged: `rejectionReport().feature` is the first
   *   rejection, in resolution order, and its message still leads.
   * - {@link Kiro_Upstream_Provider.decideDeferredEffort} runs before the report is built, so the
   *   one feature this upstream decides later than the others — `thinkingBudget`, decided inside
   *   `resolveRequestedEffort()` because it needs the model's published enum — is decided and
   *   reported here too. Without it, a request rejected on `sampling` could never report what
   *   happened to its thinking budget, however the effort branch is written.
   */
  async proxy(request: Canonical_Request, options?: RequestOptions): Promise<UpstreamResult> {
    const decisions = resolveKiroFeatures(request, { strict: this.strict })
    if (!this.mcpEmulationEnabled() && requestDeclaresMcpToolsets(request.tools)) {
      return withKiroFeatureNotices(canonicalError(400, MCP_TOOLSET_UNSUPPORTED_MESSAGE), decisions.notices())
    }
    resolveKiroHostedTools(request.tools, decisions)
    const rejection = decisions.firstRejection()
    if (rejection) {
      await this.decideDeferredEffort(request, decisions)
      // `rejectionReport()` is defined whenever `firstRejection()` is; `?? rejection` states that
      // at the type level rather than asserting it, and reaches nothing at runtime.
      const reported = decisions.rejectionReport() ?? rejection
      return withKiroFeatureNotices(canonicalError(400, reported.message), decisions.notices())
    }

    // `decisions` is handed down rather than closed over so the effort branch — the one decision
    // that needs metadata and therefore cannot be made before `generate()` — records through the
    // same collector. `notices()` is read after the await, so a notice decided inside still
    // reaches the client.
    return withKiroFeatureNotices(await this.generate(request, decisions, options), decisions.notices())
  }

  private async generate(request: Canonical_Request, decisions: FeatureDecisions, options?: RequestOptions): Promise<UpstreamResult> {
    // The intent guess is still *computed* — it decides whether the `web_search` declaration is
    // injected alongside a structured-output request, which is a tool-list question, not a
    // fabrication. What the flag gates is every path that acts on the guess by producing content
    // the model never asked for: the two synthesizers below and the preflight further down.
    const explicitWebSearch = hasExplicitWebSearchIntent(request)
    const clientWebSearchCall = this.webSearchHeuristics ? clientWebSearchToolCall(request, explicitWebSearch) : undefined
    const clientAllowedDirectoriesCall = this.webSearchHeuristics ? clientAllowedDirectoriesToolCall(request) : undefined
    const effective = computeEffectiveTools(request.tools, request.toolChoice, {
      autoWebSearch: !hasClientWebSearchTool(request) && webSearchAutoInjectEnabled() && (!request.textFormat || explicitWebSearch),
    })
    if ("error" in effective) return canonicalError(400, effective.error)

    const model = normalizeKiroModelName(request.model)
    if (clientWebSearchCall) {
      return clientToolCallResponse(request, model, clientWebSearchCall)
    }
    if (clientAllowedDirectoriesCall) {
      return clientToolCallResponse(request, model, clientAllowedDirectoriesCall)
    }

    const effortResult = await this.resolveRequestedEffort(model, request.reasoningEffort, decisions, request.thinking)
    if ("error" in effortResult) return canonicalError(effortResult.status, effortResult.error)
    const effort = effortResult.effort

    // MCP toolset expansion (task 35.2), before any payload is built, because the expanded tools go
    // into the payload's tool list. Placed after the synthesizer returns above so a request that
    // never reaches an upstream call also never opens a connection to a client's MCP server.
    //
    // A toolset that failed to expand is a dropped capability, not an error: core returns one notice
    // per dropped toolset rather than throwing (Requirement 21.3), and each is recorded through
    // `decisions` under the policy core assigned it — `resolveWithPolicy()` rather than `resolve()`,
    // because the policy travels with the notice instead of being looked up again. The rejection
    // check is what keeps strict mode honest: `proxy()` already read `firstRejection()` before
    // calling this method, so a rejection recorded here would otherwise be recorded and never
    // delivered, which is the silent drop the whole matrix exists to prevent.
    //
    // `decisions` is handed to the session because the approval split inside it (Requirement 23)
    // records through the same collector: the withholding happens either way, but without the
    // collector the client is never told, and a `require_approval: "always"` toolset — a `reject`
    // cell — would be withheld silently instead of earning its 400.
    const mcp = this.mcpEmulationEnabled() ? await createKiroMcpSession(request.tools, { signal: options?.signal, decisions }) : undefined
    for (const notice of mcp?.notices ?? []) {
      const outcome = decisions.resolveWithPolicy(notice.feature, notice.policy, notice.detail, MCP_TOOLSET_ALTERNATIVE)
      if (isFeatureRejection(outcome)) return canonicalError(400, outcome.message)
    }
    // The approval split records its own outcomes rather than returning notices, so its rejection
    // reaches the client through the same one bail point the loop above uses.
    const mcpRejection = decisions.firstRejection()
    if (mcpRejection) return canonicalError(400, mcpRejection.message)
    const effectiveTools = mcp?.tools.length ? [...effective.tools, ...mcp.tools] : effective.tools

    const fallbackWebSearchQuery = effective.webSearch ? inferWebSearchFallbackQuery(request) : undefined
    // Heuristics off: no preflight, so this request issues exactly one upstream call and any
    // `web_search` that happens comes from the model, through `maybeHandleKiroServerTool()`.
    // `fallbackWebSearchQuery` is still computed either way — it is the query the interception
    // path falls back to when the model emits `web_search` with an empty one, which is a
    // model-emitted call and therefore unaffected by the flag.
    const shouldPreflightWebSearch = Boolean(this.webSearchHeuristics && effective.webSearch && explicitWebSearch && fallbackWebSearchQuery)
    const signalClaudeContextLimit = shouldSignalClaudeContextLimit(request)
    if (shouldPreflightWebSearch && fallbackWebSearchQuery && signalClaudeContextLimit) {
      const requestForContextCheck = {
        ...request,
        instructions: buildKiroInstructions(request.instructions, request.textFormat, Boolean(effective.webSearch)),
      }
      try {
        convertCanonicalToKiroPayload(requestForContextCheck, effectiveTools, {
          modelId: model,
          authType: this.auth.getAuthType(),
          profileArn: this.auth.getProfileArn(),
          instructions: requestForContextCheck.instructions,
          payloadOverflowMode: "context_error",
          effort,
        })
      } catch (error) {
        if (error instanceof ToolNameTooLongError) return canonicalError(400, error.message)
        if (error instanceof PayloadTooLargeError) return canonicalError(error.status, error.message)
        throw error
      }
    }
    if (request.stream && shouldPreflightWebSearch && fallbackWebSearchQuery && !signalClaudeContextLimit) {
      return this.streamWithWebSearchPreflight(request, options, effectiveTools, model, fallbackWebSearchQuery, effort, Boolean(effective.webFetch), mcp)
    }

    let preflightWebSearch: Awaited<ReturnType<Kiro_Client["callMcpWebSearch"]>> | undefined
    try {
      if (shouldPreflightWebSearch && fallbackWebSearchQuery) {
        preflightWebSearch = await this.client.callMcpWebSearch(fallbackWebSearchQuery, { signal: options?.signal })
      }
    } catch (error) {
      const mapped = mapKiroError(error)
      if (mapped) return mapped
      throw error
    }

    const requestForPayload = {
      ...request,
      instructions: buildKiroInstructions(request.instructions, request.textFormat, Boolean(effective.webSearch), preflightWebSearch?.summary),
    }
    let payload
    let payloadTrimWarning = ""
    try {
      payload = convertCanonicalToKiroPayload(requestForPayload, effectiveTools, {
        modelId: model,
        authType: this.auth.getAuthType(),
        profileArn: this.auth.getProfileArn(),
        instructions: requestForPayload.instructions,
        payloadOverflowMode: signalClaudeContextLimit ? "context_error" : "trim",
        effort,
        onTrim: (notice) => {
          payloadTrimWarning = `${trimNoticeText(notice)}\n\n`
        },
      })
      options?.onRequestBody?.(JSON.stringify(payload))
    } catch (error) {
      if (error instanceof ToolNameTooLongError) return canonicalError(400, error.message)
      if (error instanceof PayloadTooLargeError) return canonicalError(error.status, error.message)
      throw error
    }
    const inputTokenEstimate = estimateInputTokens(payload)

    try {
      const upstreamResponse = request.stream
        ? await streamWithFirstTokenRetry((signal) => this.client.generateAssistantResponse(payload, { signal, stream: true }), { signal: options?.signal })
        : await this.client.generateAssistantResponse(payload, { signal: options?.signal, stream: false })
      const response = options?.onResponseBodyChunk ? withChunkCallback(upstreamResponse, options.onResponseBodyChunk) : upstreamResponse
      // One bag, two independent members, each present only when the tool that needs it was actually
      // declared to the model. `webFetch` in particular is conditional rather than always supplied:
      // `maybeHandleKiroWebFetch()` intercepts by tool name, so handing it over unconditionally would
      // hijack a client function tool that happens to be called `web_fetch` and stop forwarding it.
      const serverTools: KiroServerToolBundle | undefined = effective.webSearch || effective.webFetch
        ? {
            ...(effective.webSearch
              ? {
                  webSearch: (query: string) => this.client.callMcpWebSearch(query, { signal: options?.signal }),
                  webSearchFallbackQuery: fallbackWebSearchQuery,
                }
              : {}),
            ...(effective.webFetch ? { webFetch: (url: string) => executeKiroWebFetch(url, { signal: options?.signal }) } : {}),
          }
        : undefined
      const initialServerToolBlocks = preflightWebSearch && fallbackWebSearchQuery ? webSearchBlocks(preflightWebSearch.toolUseId, fallbackWebSearchQuery, preflightWebSearch.results) : []
      const modelMaxInputTokens = this.modelMetadata.maxInputTokens(model)
      if (request.stream) return streamKiroResponse(response, model, effectiveTools, inputTokenEstimate, serverTools, initialServerToolBlocks, payloadTrimWarning, modelMaxInputTokens, mcp)
      return collectKiroResponse(response, model, effectiveTools, inputTokenEstimate, serverTools, initialServerToolBlocks, payloadTrimWarning, modelMaxInputTokens, mcp)
    } catch (error) {
      const mapped = mapKiroError(error)
      if (mapped) return mapped
      throw error
    }
  }

  private streamWithWebSearchPreflight(
    request: Canonical_Request,
    options: RequestOptions | undefined,
    effectiveTools: JsonObject[],
    model: string,
    query: string,
    effort?: KiroEffortSelection,
    /**
     * Whether a `web_fetch` declaration reached the model on this turn, so the interceptor is offered
     * only where the tool exists — the same condition the non-preflight path applies, threaded in
     * rather than re-derived because `effectiveTools` here is already the computed list.
     */
    webFetch = false,
    mcp?: KiroMcpSession,
  ): UpstreamResult {
    const client = this.client
    const authType = this.auth.getAuthType()
    const profileArn = this.auth.getProfileArn()
    const modelMaxInputTokens = this.modelMetadata.maxInputTokens(model)
    const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`

    return {
      type: "canonical_stream",
      status: 200,
      id,
      model,
      events: {
        async *[Symbol.asyncIterator]() {
          const toolUseId = `srvtoolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`
          yield {
            type: "server_tool_block",
            blocks: [{ type: "server_tool_use", id: toolUseId, name: "web_search", input: { query } }],
          } as const

          let search: Awaited<ReturnType<Kiro_Client["callMcpWebSearch"]>>
          try {
            search = await client.callMcpWebSearch(query, { signal: options?.signal, toolUseId })
          } catch (error) {
            yield { type: "error", message: streamErrorMessage(error) } as const
            return
          }

          yield {
            type: "server_tool_block",
            blocks: webSearchBlocks(search.toolUseId, query, search.results).filter((block) => block.type !== "server_tool_use"),
          } as const

          const requestForPayload = {
            ...request,
            instructions: buildKiroInstructions(request.instructions, request.textFormat, true, search.summary),
          }
          let payload
          let payloadTrimWarning = ""
          try {
            payload = convertCanonicalToKiroPayload(requestForPayload, effectiveTools, {
              modelId: model,
              authType,
              profileArn,
              instructions: requestForPayload.instructions,
              payloadOverflowMode: shouldSignalClaudeContextLimit(request) ? "context_error" : "trim",
              effort,
              onTrim: (notice) => {
                payloadTrimWarning = `${trimNoticeText(notice)}\n\n`
              },
            })
            options?.onRequestBody?.(JSON.stringify(payload))
          } catch (error) {
            yield { type: "error", message: error instanceof Error ? error.message : String(error) } as const
            return
          }
          const inputTokenEstimate = estimateInputTokens(payload)

          let response
          try {
            const upstreamResponse = await streamWithFirstTokenRetry(
              (signal) => client.generateAssistantResponse(payload, { signal, stream: true }),
              { signal: options?.signal, maxRetries: 0 },
            )
            response = options?.onResponseBodyChunk ? withChunkCallback(upstreamResponse, options.onResponseBodyChunk) : upstreamResponse
          } catch (error) {
            yield { type: "error", message: streamErrorMessage(error) } as const
            return
          }

          const downstream = streamKiroResponse(
            response,
            model,
            effectiveTools,
            inputTokenEstimate,
            {
              webSearch: (nextQuery: string) => client.callMcpWebSearch(nextQuery, { signal: options?.signal }),
              webSearchFallbackQuery: query,
              ...(webFetch ? { webFetch: (url: string) => executeKiroWebFetch(url, { signal: options?.signal }) } : {}),
            },
            [],
            payloadTrimWarning,
            modelMaxInputTokens,
            mcp,
          )
          for await (const event of downstream.events) {
            if (event.type === "usage") {
              yield {
                ...event,
                usage: {
                  ...event.usage,
                  serverToolUse: {
                    ...event.usage.serverToolUse,
                    webSearchRequests: 1 + (event.usage.serverToolUse?.webSearchRequests ?? 0),
                  },
                },
              }
              continue
            }
            yield event
          }
        },
      },
    }
  }

  async checkHealth(timeoutMs: number) {
    return this.client.checkHealth(timeoutMs)
  }

  async usage() {
    try {
      return await this.client.getUsageLimits()
    } catch {
      return Response.json({ error: "Usage limits unavailable" }, { status: 502 })
    }
  }

  async listModels() {
    if (this.modelCache && Date.now() - this.modelCache.cachedAt < MODEL_CACHE_TTL_SECONDS * 1000) return this.modelCache.models
    try {
      const fullBody = await this.client.listAvailableModelsFull()
      this.modelMetadata.populate(fullBody)
      const models = dedupe(this.modelMetadata.modelIds().map(normalizeKiroModelName))
      this.modelCache = { models, cachedAt: Date.now() }
      return models
    } catch {
      return HIDDEN_KIRO_MODELS
    }
  }

  async listModelDescriptors() {
    const modelIds = await this.listModels()
    return modelIds.map((id) => {
      const metadata = this.modelMetadata.get(id)
      if (!metadata?.richMetadata) return id
      return {
        id,
        displayName: metadata.modelName,
        maxInputTokens: metadata.maxInputTokens,
        maxOutputTokens: metadata.maxOutputTokens,
        supportsImages: metadata.supportsImages,
        ...(metadata.effort ? { effort: { ...metadata.effort, levels: [...metadata.effort.levels] } } : {}),
      }
    })
  }

  /**
   * Refresh model metadata from the Kiro API.
   * Called at startup and can be called on account switch.
   */
  async refreshModelMetadata(): Promise<void> {
    try {
      const fullBody = await this.client.listAvailableModelsFull()
      this.modelMetadata.populate(fullBody)
      const models = dedupe(this.modelMetadata.modelIds().map(normalizeKiroModelName))
      this.modelCache = { models, cachedAt: Date.now() }
    } catch {
      // Non-fatal — metadata will use defaults
    }
  }

  /**
   * Decide the effort feature on a request that is about to be refused, for the record only.
   *
   * `thinkingBudget` is the one matrix-covered feature this upstream cannot decide alongside the
   * others: the outcome depends on the enum the *model* publishes, so it is settled inside
   * {@link Kiro_Upstream_Provider.resolveRequestedEffort}, which runs in `generate()` — after the
   * rejection bail. A request rejected on `sampling` therefore reported `outputLength` and
   * `toolChoiceForced` and stayed silent about a thinking budget it had also been sent, which is a
   * silent drop wearing a 400's clothes (Requirement 10.11 read over every feature the request
   * carried).
   *
   * So the decision is made here, on the rejection path, purely so `decisions` holds it before the
   * report is built. Three deliberate properties:
   *
   * - **The result is discarded, not returned.** Whatever this decides cannot change the response:
   *   the 400 and the feature that caused it are already fixed, and a `metadata_unavailable` 503
   *   from the effort resolver must not replace a rejection the request has already earned. Only
   *   the *record* is wanted, and `FeatureDecisions` keeps it.
   * - **A recorded rejection here does not become the cause.** `firstRejection()` is
   *   resolution-ordered and this runs last, so an escalated `thinkingBudget` under
   *   `NATIVE_STRICT` is named by `rejectionReport()` as a further rejection and never as the head.
   * - **A request that stated no effort intent is left exactly as it was.** No level and no budget
   *   means there is no `thinkingBudget` decision to make — the only rung that could fire is the
   *   model default, which reports nothing by design — so this returns before touching model
   *   metadata and the refused request stays byte-identical to the one it produced before
   *   (Requirement 10.12), at zero added cost.
   */
  private async decideDeferredEffort(request: Canonical_Request, decisions: FeatureDecisions): Promise<void> {
    if (!requestStatesEffortIntent(request)) return
    await this.resolveRequestedEffort(normalizeKiroModelName(request.model), request.reasoningEffort, decisions, request.thinking)
  }

  /**
   * Decide what effort — if any — this request puts on the wire.
   *
   * The classification is not made here: `validateKiroEffort()` (`./effort.ts`) owns it, and the
   * level itself comes from `selectEffortLevel()`, so this method's only work is *what to do* with
   * a classified result. Three outcomes, one per class:
   *
   * - valid — send the level the selector chose, silently. Nothing was substituted, so there is
   *   nothing to report (Requirement 16.8's "zero notices" half).
   * - out of the model's enum — send `nearest`, which is by construction a member of that same
   *   enum, and report both values (Requirements 16.4, 3.4). The refusal this used to be turned a
   *   working request into a 400 over a value the gateway could translate.
   * - no effort enum on this model — send nothing and report it (Requirement 16.6's other half:
   *   a missing capability is a feature gap, so it degrades rather than rejecting).
   *
   * A fourth path, added by task 23.1, sits before those three: when the client stated **no** level
   * but did send `thinking.budgetTokens`, the budget is mapped onto a published level and the
   * mapping is reported. It is a separate branch rather than a fourth class because nothing was
   * classified — no level was stated, so there is nothing to validate.
   *
   * `NATIVE_STRICT` is *not* read here. Both degradations go through
   * `FeatureDecisions.resolve()` → `resolveFeature()`, the single function in the repository that
   * interprets the flag, so strict mode escalates them to a 400 without a second `if (strict)`
   * living at this site (design decision D3, Requirement 16.5).
   *
   * Unloaded metadata stays a 503 with its existing message: the enum is unknown, so no claim
   * about the requested level is possible, and that is infrastructure rather than a feature gap
   * (Requirement 16.6).
   */
  private async resolveRequestedEffort(model: string, requested: string | undefined, decisions: FeatureDecisions, thinking?: Canonical_Request["thinking"]): Promise<
    | { effort?: KiroEffortSelection }
    | { error: string; status: number }
  > {
    // Task 23.1 — the token budget is the one other thing the *client* can send that produces a
    // level. `disabled` asks for no reasoning at all, so its budget is not consulted (Requirement
    // 16.9); `selectEffortLevel()` enforces the same rule, and reading it here keeps a disabled
    // request from paying for a metadata fetch.
    const budgetTokens = thinking?.mode === "disabled" ? undefined : thinking?.budgetTokens

    // Rung 0, and the only fast path left: a client that switched reasoning off and named no level
    // has asked for silence, so no descriptor can change the answer and the metadata fetch is pure
    // cost. Narrowed to `!requested` on purpose — a *stated* level beside `disabled` still goes
    // through the classifier below, exactly as before, because the reject/degrade handling of a
    // stated value is not this change's business.
    //
    // There used to be a second condition here — `!requested && budgetTokens === undefined` also
    // returned early — and it was a bug: it returned *before* the descriptor was read, so
    // `selectEffortLevel()`'s model-default rung was unreachable on this upstream. That rung is
    // exactly what Requirement 16.1 asks for ("apply `defaultLevel` when the client omits effort"),
    // and a request that states neither a level nor a budget is precisely the input it exists for.
    // Measured evidence that it never ran: on one live run, with one descriptor and one model, a
    // request stating a level and a request sending a budget both put a level on the payload, while
    // a request stating nothing put none. Loading metadata is cheap enough to stop guarding against:
    // `isPopulated` makes it at most one fetch per session, and every other branch below already
    // pays it.
    if (!requested && thinking?.mode === "disabled") return {}
    if (!this.modelMetadata.isPopulated) await this.refreshModelMetadata()

    // `null` and `undefined` are deliberately different descriptors: "we do not know this model's
    // enum" is the 503 below, "this model publishes no enum" is a notice. Collapsing them here
    // would put the distinction back in this method after `./effort.ts` was given it.
    const metadata = this.modelMetadata.isPopulated ? this.modelMetadata.get(model)?.effort : null

    // The two rungs that can produce a level without the client stating one, in the selector's own
    // order: the token budget, then the model's own default. An explicit value outranks both and
    // reports nothing (Requirement 16.8), which is why this branch is guarded on `!requested`.
    //
    // Only the budget rung reports. Kiro's wire format has no budget field, so a mapped budget is a
    // changed semantic and the notice names both sides of the mapping (Requirement 16.7). The
    // model-default rung changes nothing the client asked for — it fills a silence with the model's
    // own published default (Requirement 16.1) — so it sends the level and says nothing, the same
    // way a stated in-enum level is sent silently.
    //
    // A decision that is not `selected` leaves this branch silent: an unloaded or absent enum has
    // nothing to offer, and a model whose descriptor carries no default has nothing to say
    // (Requirement 16.2). Note what that means alongside the disclosure rule in
    // `./model-metadata.ts` — a model whose live entry denied `additionalModelRequestFields` has no
    // descriptor at all, so this branch sends nothing to it and the request keeps its 200. The
    // model-default rung cannot resurrect a field the endpoint refused.
    if (!requested) {
      const decision = metadata ? selectEffortLevel(metadata, { thinking }) : undefined
      if (decision?.kind !== "selected") return {}
      if (decision.source !== "budget") return { effort: decision.effort }
      const level = decision.effort.level
      const outcome = decisions.resolve(
        "thinkingBudget",
        `Kiro has no thinking budget field, so the requested budget_tokens was mapped onto the nearest effort level this model publishes: ${budgetTokens} → ${level}; supports: ${metadata!.levels.join(", ")}`,
        "an upstream that honors a thinking token budget, or state an effort level directly",
      )
      if (isFeatureRejection(outcome)) return { status: 400, error: outcome.message }
      return { effort: decision.effort }
    }

    const validation = validateKiroEffort(metadata, requested)
    if (validation.ok) {
      const decision = selectEffortLevel(metadata ?? undefined, { requested })
      return decision.kind === "selected" ? { effort: decision.effort } : {}
    }
    if (validation.code === "metadata_unavailable") {
      return { status: validation.status, error: `Unable to load Kiro model metadata required to validate effort '${requested}' for '${model}'` }
    }

    const degradation = effortDegradation(model, validation, metadata)
    const outcome = decisions.resolve("thinkingBudget", degradation.detail, degradation.alternative)
    if (isFeatureRejection(outcome)) return { status: 400, error: outcome.message }
    return degradation.effort ? { effort: degradation.effort } : {}
  }

  async listModelsRaw(): Promise<Response> {
    return this.client.listAvailableModelsRaw()
  }

  async modelsRaw(options?: RequestOptions): Promise<Response> {
    return this.listModelsRaw()
  }

  getAuthType() {
    return this.auth.getAuthType()
  }

  getRegion() {
    return this.auth.getRegion()
  }

  getProfileArn() {
    return this.auth.getProfileArn()
  }
}

/**
 * The hosted tool types that mean "fetch this page", including the dated spellings.
 *
 * A predicate rather than a set literal, because the Claude API versions the type name
 * (`web_fetch_20250910`, `web_fetch_20260209`, …) and a set would need an edit per release. Matches
 * the shape `isClientWebFetchToolName()` below already accepts, so the two readings of "this is a
 * fetch tool" cannot drift.
 */
function isServerWebFetchToolType(type: unknown) {
  return typeof type === "string" && /^web[_-]?fetch(?:_\d+)?$/i.test(type)
}

export function computeEffectiveTools(tools: JsonObject[] = [], toolChoice?: JsonObject | string, options: { autoWebSearch?: boolean } = {}): { tools: JsonObject[]; webSearch?: boolean; webFetch?: boolean } | { error: string } {
  const hasServerWebSearch = tools.some((tool) => tool.type === "web_search")
  const functionTools = tools.filter((tool) => tool.type === "function")
  const shouldProvideWebSearch = hasServerWebSearch || Boolean(options.autoWebSearch)
  const injectedWebSearch = shouldProvideWebSearch && !functionTools.some((tool) => tool.name === "web_search") ? kiroWebSearchTool() : undefined
  // The `web_fetch` mirror of the line above, with one deliberate difference: there is no
  // `autoWebFetch`. A fetch has no query to infer and no prompt to guess from, so the declaration is
  // injected only where the client actually asked for a fetch tool (Requirements 18.1, 18.2). This
  // endpoint has no hosted fetch tool at all — the probe found `tools/list` carries only
  // `web_search` — so the injected declaration is an ordinary function tool the gateway itself runs.
  const hasServerWebFetch = tools.some((tool) => isServerWebFetchToolType(tool.type))
  const injectedWebFetch = hasServerWebFetch && !functionTools.some((tool) => tool.name === KIRO_WEB_FETCH_TOOL_NAME) ? kiroWebFetchTool() : undefined
  const allTools = [
    ...(injectedWebSearch ? [injectedWebSearch] : []),
    ...(injectedWebFetch ? [injectedWebFetch] : []),
    ...(injectedWebSearch ? functionTools : prioritizeWebSearch(functionTools)),
  ]
  const webSearchEnabled = shouldProvideWebSearch && allTools.some((tool) => tool.name === "web_search")
  const webFetchEnabled = hasServerWebFetch && allTools.some((tool) => tool.name === KIRO_WEB_FETCH_TOOL_NAME)
  /** Which interceptors this tool list earns, spread into every non-narrowed return below. */
  const webTools = {
    ...(webSearchEnabled ? { webSearch: true } : {}),
    ...(webFetchEnabled ? { webFetch: true } : {}),
  }

  if (!toolChoice || toolChoice === "auto") return { tools: allTools, ...webTools }
  if (toolChoice === "none") return { tools: [] }
  // `required` and a named choice each wrote a console warning here. A warning in the gateway's
  // own stdout told the operator and never the client, which is the silent drop Requirement 10.4
  // removes: both are now resolved as `toolChoiceForced` in `./features.ts`, so the client is
  // told through a Feature_Notice. This function stays a pure tool-list computation.
  if (toolChoice === "required") {
    return { tools: allTools, ...(webSearchEnabled ? { webSearch: true } : {}) }
  }
  if (typeof toolChoice === "object" && toolChoice.type === "web_search") {
    const found = allTools.find((tool) => tool.name === "web_search")
    return found ? { tools: [found], ...(webSearchEnabled ? { webSearch: true } : {}) } : { error: "web_search tool_choice was requested but web_search was not provided" }
  }
  if (typeof toolChoice === "object" && typeof toolChoice.name === "string") {
    const found = allTools.find((tool) => tool.name === toolChoice.name)
    return found ? { tools: [found], ...(webSearchEnabled && found.name === "web_search" ? { webSearch: true } : {}) } : { error: `Named tool_choice '${toolChoice.name}' was not found in provided tools` }
  }
  if (typeof toolChoice === "object" && toolChoice.type === "function" && typeof (toolChoice as { function?: { name?: unknown } }).function?.name === "string") {
    const name = (toolChoice as { function: { name: string } }).function.name
    const found = allTools.find((tool) => tool.name === name)
    return found ? { tools: [found], ...(webSearchEnabled && found.name === "web_search" ? { webSearch: true } : {}) } : { error: `Named tool_choice '${name}' was not found in provided tools` }
  }
  return { tools: allTools, ...(webSearchEnabled ? { webSearch: true } : {}) }
}

/**
 * The prose and the substituted level for one effort degradation.
 *
 * Two texts because the two classes are two different events: one says "this level became that
 * level", the other says "there was no level to send". A client told the first when the second
 * happened would go looking for a substituted value that does not exist.
 *
 * `effort` is present only for the substitution class, and its level is `validation.nearest` —
 * drawn from the model's own `levels` by `validateKiroEffort()`, so degrading cannot put an
 * invented value on the wire (Property 14). It is omitted for the unsupported class because there
 * is no enum to draw from.
 *
 * `detail` names the requested value and the substituted level, which is what Requirement 16.4
 * asks the notice to carry; `alternative` is what to send instead, used verbatim in the strict-mode
 * 400 that `resolveFeature()` builds from the same pair.
 */
function effortDegradation(
  model: string,
  validation: Extract<EffortValidation, { code: "effort_not_in_enum" | "effort_unsupported" }>,
  metadata: KiroModelEffortMetadata | undefined | null,
): { detail: string; alternative: string; effort?: KiroEffortSelection } {
  if (validation.code === "effort_unsupported") {
    return {
      detail: `Kiro model '${model}' does not support configurable effort, so the requested effort '${validation.requested}' was left off the request and the model reasons as it sees fit`,
      alternative: "a model that publishes effort levels, or omit the effort value",
    }
  }
  return {
    detail: `Kiro model '${model}' does not support effort '${validation.requested}'; the nearest level it accepts, '${validation.nearest}', was sent instead; supports: ${validation.levels.join(", ")}`,
    alternative: `one of the effort levels this model accepts: ${validation.levels.join(", ")}`,
    // `metadata` is always a descriptor for this class — a model with no enum cannot produce an
    // out-of-enum result — and the guard keeps that a fact rather than an assertion.
    ...(metadata ? { effort: { schemaPath: metadata.schemaPath, level: validation.nearest } } : {}),
  }
}

function shouldSignalClaudeContextLimit(request: Canonical_Request) {
  return request.metadata.source === "claude"
}

export function normalizeKiroModelName(model: string) {
  let normalized = model.replace(/(-\d+(?:-\d+)?)-latest$/, "$1").replace(/-\d{8}$/, "")
  normalized = normalized.replace(/^(claude-[a-z]+-\d+)-(\d+)$/, "$1.$2")
  normalized = normalized.replace(/^(claude-\d+)-(\d+)(-[a-z]+.*)$/, "$1.$2$3")
  return normalized
}

/**
 * The 400 an MCP-bearing request gets while `NATIVE_MCP_EMULATION` is off.
 *
 * Verbatim the message `validateUnsupportedServerTools()` returned for the same request, so turning
 * the flag off restores the previous behavior byte for byte rather than approximately
 * (Requirement 22.5). That function's other two messages are gone with it: `web_fetch` is emulated
 * now (task 28.2) and the combined case it covered can no longer arise.
 */
const MCP_TOOLSET_UNSUPPORTED_MESSAGE = "Kiro upstream does not support generic server-side MCP toolsets. Use normal client function tools or the gateway web_search helper instead."

/** What to do instead when a declared MCP toolset could not be expanded. */
const MCP_TOOLSET_ALTERNATIVE = "an upstream that hosts the MCP server itself, a reachable server URL, or plain client function tools"

function canonicalError(status: number, body: string): Canonical_ErrorResponse {
  return { type: "canonical_error", status, headers: new Headers(), body }
}

function streamErrorMessage(error: unknown) {
  if (error instanceof FirstTokenTimeoutError) return error.message
  if (error instanceof KiroHttpError) return publicHttpErrorBody(error.status, error.body, error.category)
  if (error instanceof KiroNetworkError) return error.message
  if (error instanceof KiroMcpError) return error.message
  return error instanceof Error ? error.message : String(error)
}

function mapKiroError(error: unknown): Canonical_ErrorResponse | undefined {
  if (error instanceof FirstTokenTimeoutError) return canonicalError(504, error.message)
  if (error instanceof KiroHttpError) return { type: "canonical_error", status: error.status, headers: error.headers, body: publicHttpErrorBody(error.status, error.body, error.category) }
  if (error instanceof KiroNetworkError) return canonicalError(504, error.message)
  if (error instanceof KiroMcpError) return canonicalError(502, error.message)
}

const inputTokenEstimateEncoder = new TextEncoder()

/**
 * Estimate input tokens from a Kiro payload.
 *
 * Strips base64 image data before estimating because image bytes should not
 * be counted as text tokens — Anthropic uses a fixed per-image token cost
 * based on dimensions, not data size.  A 1 MB base64 string would otherwise
 * inflate the estimate by ~250 K "tokens".
 */
function estimateInputTokens(value: unknown) {
  const serialized = JSON.stringify(value)
  if (!serialized) return 0
  // Remove base64 image payloads from the estimate.  The regex targets the
  // Kiro image format: {"format":"...","source":{"bytes":"<base64>"}}
  // We replace the base64 content with a short placeholder so the structural
  // JSON overhead is still counted but the raw image data is not.
  const withoutImages = serialized.replace(/"bytes":"[A-Za-z0-9+/=]{256,}"/g, '"bytes":"[image]"')
  return Math.ceil(inputTokenEstimateEncoder.encode(withoutImages).length / 4)
}

function buildKiroInstructions(instructions: string | undefined, textFormat: JsonObject | undefined, webSearch: boolean, webSearchContext?: string) {
  const additions = [
    webSearch
      ? [
          "Web search policy for this gateway:",
          "- The tool named `web_search` is available for explicit websearch/web search requests, URL lookup, article/page summarization, current/recent/external information, news, consumer tech, and product information.",
          "- These requests are in scope even when they are unrelated to programming or software development.",
          "- When the user provides a URL or asks to use websearch/web search, call `web_search` with a non-empty `query` string. If a URL is present, use that URL as the query.",
          "- Do not refuse because the request is outside coding or software development; do not say you cannot browse before trying `web_search`.",
          "- After search results are available, answer directly in the user's language.",
        ].join("\n")
      : undefined,
    webSearchContext
      ? [
          "The gateway has already executed `web_search` for this turn.",
          "Use the following search results as source context for the final answer. Do not print the raw <web_search> block.",
          webSearchContext,
        ].join("\n")
      : undefined,
    structuredOutputInstruction(textFormat),
  ].filter((item): item is string => Boolean(item))

  return additions.reduce((acc, addition) => {
    if (acc?.includes(addition)) return acc
    return [acc, addition].filter(Boolean).join("\n\n")
  }, instructions)
}

function prioritizeWebSearch(tools: JsonObject[]) {
  const webSearch = tools.find((tool) => tool.name === "web_search")
  if (!webSearch) return tools
  return [webSearch, ...tools.filter((tool) => tool !== webSearch)]
}

function inferWebSearchFallbackQuery(request: Canonical_Request) {
  const text = webSearchQueryText(currentUserText(request))
  if (!text) return
  const url = text.match(/https?:\/\/[^\s<>"')\]]+/)?.[0]?.replace(/[),.;]+$/, "")
  return url || text.slice(0, 500)
}

function hasExplicitWebSearchIntent(request: Canonical_Request) {
  const text = currentUserText(request)
  if (!text) return false
  return /https?:\/\//i.test(text) || /\bweb\s*search\b|\bwebsearch\b|tìm kiếm web|tra cứu web|sử dụng web/i.test(text)
}

function currentUserText(request: Canonical_Request) {
  const message = request.input.at(-1)
  if (message?.role !== "user") return ""
  return message.content.flatMap(contentText).map(stripHiddenContext).map((text) => text.trim()).filter(Boolean).join("\n").trim()
}

function hasClientWebSearchTool(request: Canonical_Request) {
  return typeof request.metadata.claudeClientWebSearchToolName === "string"
}

function clientWebSearchToolCall(request: Canonical_Request, explicitWebSearch: boolean) {
  if (!explicitWebSearch) return
  if (request.toolChoice === "none") return
  const query = inferWebSearchFallbackQuery(request)
  if (!query) return
  const name = selectClientWebToolName(request, query)
  if (!name) return
  const toolArguments = clientWebSearchArguments(name, query)
  if (!toolArguments) return
  return { name, arguments: JSON.stringify(toolArguments) }
}

function clientWebSearchArguments(name: string, query: string) {
  if (isClientWebFetchToolName(name)) {
    if (!isUrlQuery(query)) return
    return { url: query, prompt: "Summarize this page for the user." }
  }
  return { query }
}

function selectClientWebToolName(request: Canonical_Request, query: string) {
  const metadataName = typeof request.metadata.claudeClientWebSearchToolName === "string" && isClientWebToolName(request.metadata.claudeClientWebSearchToolName)
    ? request.metadata.claudeClientWebSearchToolName
    : undefined
  if (!metadataName) return

  const chosen = selectedToolChoiceName(request)
  if (chosen) {
    if (!isClientWebToolName(chosen)) return
    return canUseClientWebTool(chosen, query) ? chosen : undefined
  }
  if (request.toolChoice && typeof request.toolChoice === "object" && request.toolChoice.type !== "function") return

  const names = dedupe([
    metadataName,
    ...clientWebToolNames(request),
  ])
  if (!isUrlQuery(query)) return names.find(isClientWebSearchToolName)
  return names.find((name) => name === metadataName && canUseClientWebTool(name, query))
    ?? names.find((name) => canUseClientWebTool(name, query))
}

function selectedToolChoiceName(request: Canonical_Request) {
  if (!request.toolChoice || typeof request.toolChoice !== "object") return
  if (typeof request.toolChoice.name === "string") return request.toolChoice.name
  const functionChoice = request.toolChoice.function as JsonObject | undefined
  return typeof functionChoice?.name === "string" ? functionChoice.name : undefined
}

function clientWebToolNames(request: Canonical_Request) {
  return (request.tools ?? []).flatMap((tool) => typeof tool.name === "string" && isClientWebToolName(tool.name) ? [tool.name] : [])
}

function canUseClientWebTool(name: string, query: string | undefined) {
  return isClientWebFetchToolName(name) ? Boolean(query && isUrlQuery(query)) : isClientWebSearchToolName(name)
}

function isClientWebToolName(name: string) {
  return /^web[_-]?(search|fetch)(?:_\d+)?$/i.test(name)
}

function isClientWebSearchToolName(name: string) {
  return /^web[_-]?search(?:_\d+)?$/i.test(name)
}

function isClientWebFetchToolName(name: string) {
  return /^web[_-]?fetch(?:_\d+)?$/i.test(name)
}

function isUrlQuery(query: string) {
  return /^https?:\/\//i.test(query)
}

function clientAllowedDirectoriesToolCall(request: Canonical_Request) {
  if (!hasAllowedDirectoriesIntent(request)) return
  if (request.toolChoice === "none") return
  const tool = request.tools?.find((item) => typeof item.name === "string" && /(?:^|__)list_allowed_directories$/i.test(item.name))
  const name = typeof tool?.name === "string" ? tool.name : undefined
  if (!name) return
  if (typeof request.toolChoice === "object" && request.toolChoice) {
    const chosen = typeof request.toolChoice.name === "string" ? request.toolChoice.name
      : typeof (request.toolChoice.function as JsonObject | undefined)?.name === "string" ? (request.toolChoice.function as JsonObject).name
        : undefined
    if (chosen && chosen !== name) return
  }
  return { name, arguments: "{}" }
}

function hasAllowedDirectoriesIntent(request: Canonical_Request) {
  const text = currentUserText(request)
  if (!text) return false
  const normalized = text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
  return /\blist[_\s-]*allowed[_\s-]*directories\b|\ballowed directories\b/i.test(text)
    || /(thư mục|folder|directories?|thu muc).*(được phép|có thể|duoc phep|co the).*(truy cập|đọc|truy cap|doc)/i.test(text)
    || /(truy cập|đọc|truy cap|doc).*(thư mục|folder|directories?|thu muc).*(nào|gì|nao|gi)/i.test(text)
    || /(thu muc|folder|directories?).*(duoc phep|co the).*(truy cap|doc)/i.test(normalized)
    || /(truy cap|doc).*(thu muc|folder|directories?).*(nao|gi)/i.test(normalized)
}

function clientToolCallResponse(
  request: Canonical_Request,
  model: string,
  call: { name: string; arguments: string },
): Canonical_Response | Canonical_StreamResponse {
  const id = `resp_${crypto.randomUUID().replace(/-/g, "")}`
  const callId = `toolu_${crypto.randomUUID().replace(/-/g, "")}`
  const usage = { inputTokens: estimateInputTokens(request), outputTokens: 0 }

  if (!request.stream) {
    return {
      type: "canonical_response",
      id,
      model,
      stopReason: "tool_use",
      content: [{ type: "tool_call", id: `fc_${crypto.randomUUID().replace(/-/g, "")}`, callId, name: call.name, arguments: call.arguments }],
      usage,
    }
  }

  return {
    type: "canonical_stream",
    status: 200,
    id,
    model,
    events: {
      async *[Symbol.asyncIterator]() {
        yield { type: "tool_call_done", callId, name: call.name, arguments: call.arguments } as const
        yield { type: "usage", usage } as const
        yield { type: "message_stop", stopReason: "tool_use" } as const
      },
    },
  }
}

function contentText(block: JsonObject) {
  if (typeof block.text === "string") return [block.text]
  if (typeof block.content === "string") return [block.content]
  return []
}

function stripHiddenContext(text: string) {
  return ["system-reminder", "project-memory-context", "local-command-caveat", "command-name", "command-message", "command-args", "local-command-stdout"].reduce((acc, tag) => {
    const closed = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi")
    const open = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, "gi")
    return acc.replace(closed, "").replace(open, "")
  }, text)
}

function webSearchQueryText(text: string) {
  const match = text.match(/^Perform a web search for the query:\s*([\s\S]*)$/i)
  return (match ? match[1] : text).trim()
}

function structuredOutputInstruction(textFormat: JsonObject | undefined) {
  if (!textFormat) return
  const name = typeof textFormat.name === "string" && textFormat.name.trim() ? textFormat.name.trim() : "structured_output"
  const schema = textFormat.schema ?? textFormat
  return [
    `Structured output requested (${name}). Kiro does not support native structured output, so emulate it exactly.`,
    "Return only valid JSON that matches the requested schema. Do not include markdown fences, prose, or any text outside the JSON object.",
    `JSON schema: ${JSON.stringify(schema)}`,
  ].join("\n")
}

function webSearchAutoInjectEnabled() {
  const value = process.env.KIRO_WEB_SEARCH_ENABLED ?? process.env.WEB_SEARCH_ENABLED
  if (value === undefined) return true
  return ["true", "1", "yes"].includes(value.toLowerCase())
}

function dedupe(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

export { Kiro_Auth_Manager } from "./auth"
export { Kiro_Client } from "./client"
export { KiroModelMetadataRegistry } from "./model-metadata"
export type { KiroModelMetadata } from "./model-metadata"
/**
 * Web search re-exports, retained under their pre-rename names.
 *
 * `./mcp` became `./web-search` in task 26.1 (Requirement 17.1). Every name this barrel exported
 * before that rename is still exported here, from the new module, so no importer of
 * `src/upstream/kiro` breaks on the move — this is the alias site Requirement 17.2 names.
 *
 * @deprecated Import from `src/upstream/kiro/web-search` instead. This barrel re-export is kept for
 * one release cycle only and is removed after it. Covered by Property 24 in
 * `test/upstream/kiro/web-search-export-surface.property.test.ts`.
 */
export { extractWebSearchQuery, kiroWebSearchTool, parseMcpWebSearchResults, webSearchBlocks, webSearchSummary } from "./web-search"
export { classifyHttpError, classifyNetworkError, publicHttpErrorBody, redact as redactKiroErrorText } from "./errors"
export { CLAUDE_CONTEXT_LIMIT_MESSAGE, convertCanonicalToKiroPayload, sanitizeToolSchema, trimNoticeText } from "./payload"
export type { KiroPayloadTrimNotice } from "./payload"
export { AwsEventStreamParser, ThinkingBlockExtractor, collectKiroResponse, streamKiroResponse } from "./parse"
export { FirstTokenTimeoutError, streamWithFirstTokenRetry } from "./stream-retry"
export type * from "./types"
