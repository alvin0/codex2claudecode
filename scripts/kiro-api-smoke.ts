const hostname = process.env.HOST ?? "127.0.0.1"
const port = Number(process.env.PORT ?? 8787)
const baseUrl = process.env.KIRO_TEST_BASE_URL ?? `http://${hostname}:${port}`
const model = process.env.KIRO_TEST_MODEL ?? "claude-sonnet-4.5"
const timeoutMs = Number(process.env.KIRO_TEST_TIMEOUT_MS ?? 60_000)
const skipStart = process.env.KIRO_TEST_SKIP_START === "1"

let child: ReturnType<typeof Bun.spawn> | undefined

try {
  if (!skipStart) {
    child = Bun.spawn({
      cmd: ["bun", "index.ts", "--port", String(port)],
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_NO_UI: "1",
        UPSTREAM_PROVIDER: "kiro",
        PORT: String(port),
      },
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    })
    if (child.stdout instanceof ReadableStream) pipeProcessOutput(child.stdout, "[server] ", "stdout")
    if (child.stderr instanceof ReadableStream) pipeProcessOutput(child.stderr, "[server] ", "stderr")
  }

  await waitForHealth()
  await getJson("/", 200, "root")
  await getJsonOneOf("/health", [200, 503], "health")
  await getJson("/v1/models", 200, "models")
  await postJson("/v1/messages/count_tokens", claudePayload(), 200, "count tokens")
  // Claude messages requires a live upstream — accept 200 (success) or upstream
  // gateway errors (502/503/504) which confirm the route is wired correctly.
  await postJsonOneOf("/v1/messages", claudePayload({ max_tokens: 64 }), [200, 502, 503, 504], "Claude messages")

  // ── Streaming tests ──
  await testClaudeStream(claudePayload({ max_tokens: 64, stream: true }), "Claude messages stream")
  await testClaudeStream(
    claudePayload({ max_tokens: 256, stream: true, messages: [{ role: "user", content: "Count from 1 to 5, one number per line" }] }),
    "Claude messages stream (multi-token)",
  )

  await postJson("/v1/responses", { model, input: "hello" }, 404, "OpenAI responses disabled in Kiro mode")
  await getJsonOneOf("/usage", [200, 501, 502, 504], "usage")
  await getJson("/environments", 501, "environments unsupported in Kiro mode")
  console.log("\nKiro API smoke test passed.")
} finally {
  if (child && !child.killed) child.kill("SIGTERM")
}

async function pipeProcessOutput(stream: ReadableStream<Uint8Array>, prefix: string, target: "stdout" | "stderr") {
  const writer = target === "stdout" ? process.stdout : process.stderr
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      writer.write(prefixLines(decoder.decode(chunk.value, { stream: true }), prefix))
    }
    const tail = decoder.decode()
    if (tail) writer.write(prefixLines(tail, prefix))
  } catch {
    return
  }
}

function claudePayload(overrides: Record<string, unknown> = {}) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: "Reply with exactly: ok",
      },
    ],
    ...overrides,
  }
}

async function waitForHealth() {
  const deadline = Date.now() + timeoutMs
  let lastError = ""

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      // Accept any JSON response from the server — the runtime is up even if
      // the upstream health check hasn't passed yet.  The individual API tests
      // will surface real upstream failures.
      if (response.status < 500 || response.headers.get("content-type")?.includes("json")) return
      lastError = `${response.status} ${await response.text()}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(500)
  }

  throw new Error(`Timed out waiting for Kiro runtime at ${baseUrl}/health: ${lastError}`)
}

async function getJson(path: string, expectedStatus: number, label: string) {
  const response = await fetch(`${baseUrl}${path}`)
  await assertResponse(response, expectedStatus, label)
}

async function getJsonOneOf(path: string, expectedStatuses: number[], label: string) {
  const response = await fetch(`${baseUrl}${path}`)
  await assertResponseOneOf(response, expectedStatuses, label)
}

async function postJson(path: string, body: unknown, expectedStatus: number, label: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  await assertResponse(response, expectedStatus, label)
}

async function postJsonOneOf(path: string, body: unknown, expectedStatuses: number[], label: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  await assertResponseOneOf(response, expectedStatuses, label)
}

async function assertResponse(response: Response, expectedStatus: number, label: string) {
  const text = await response.text()
  const ok = response.status === expectedStatus
  const preview = text.replace(/\s+/g, " ").slice(0, 220)
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${response.status}${preview ? ` ${preview}` : ""}`)
  if (!ok) throw new Error(`${label} expected ${expectedStatus}, got ${response.status}: ${text}`)
}

async function assertResponseOneOf(response: Response, expectedStatuses: number[], label: string) {
  const text = await response.text()
  const ok = expectedStatuses.includes(response.status)
  const preview = text.replace(/\s+/g, " ").slice(0, 220)
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${response.status}${preview ? ` ${preview}` : ""}`)
  if (!ok) throw new Error(`${label} expected one of [${expectedStatuses.join(", ")}], got ${response.status}: ${text}`)
}

// ── Streaming helpers ──

interface SseEvent {
  event: string
  data: string
}

/** Parse raw SSE text into structured events. */
function parseSseEvents(raw: string): SseEvent[] {
  const events: SseEvent[] = []
  let currentEvent = ""
  let currentData = ""

  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7)
    } else if (line.startsWith("data: ")) {
      currentData = line.slice(6)
    } else if (line === "" && (currentEvent || currentData)) {
      events.push({ event: currentEvent, data: currentData })
      currentEvent = ""
      currentData = ""
    }
  }
  return events
}

/**
 * Test a Claude streaming request.
 *
 * When the upstream is reachable (200) we validate the full SSE lifecycle:
 *   message_start → content_block_start → content_block_delta(s) →
 *   content_block_stop → message_delta → message_stop
 *
 * When the upstream is unreachable (502/503/504) we accept the error as proof
 * that the streaming route is wired correctly — same as the non-stream test.
 */
async function testClaudeStream(body: unknown, label: string) {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  // Upstream unreachable — route is wired, just can't reach the backend.
  if ([502, 503, 504].includes(response.status)) {
    const text = await response.text()
    const preview = text.replace(/\s+/g, " ").slice(0, 220)
    console.log(`PASS ${label}: ${response.status} (upstream unavailable) ${preview}`)
    return
  }

  if (response.status !== 200) {
    const text = await response.text()
    throw new Error(`${label} expected 200 or upstream error, got ${response.status}: ${text}`)
  }

  // ── Validate SSE content-type ──
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/event-stream")) {
    throw new Error(`${label} expected text/event-stream content-type, got ${contentType}`)
  }

  // ── Read the full SSE body ──
  const raw = await response.text()
  const events = parseSseEvents(raw)

  if (events.length === 0) {
    throw new Error(`${label} received no SSE events`)
  }

  // ── Validate event lifecycle ──
  const eventTypes = events.map((e) => e.event)

  // Must start with message_start
  if (eventTypes[0] !== "message_start") {
    throw new Error(`${label} first event should be message_start, got ${eventTypes[0]}`)
  }

  // Must end with message_stop
  if (eventTypes[eventTypes.length - 1] !== "message_stop") {
    throw new Error(`${label} last event should be message_stop, got ${eventTypes[eventTypes.length - 1]}`)
  }

  // Validate message_start data
  const messageStart = JSON.parse(events[0].data)
  if (messageStart.type !== "message_start" || !messageStart.message) {
    throw new Error(`${label} message_start event has invalid structure`)
  }
  if (messageStart.message.role !== "assistant") {
    throw new Error(`${label} message_start role should be assistant, got ${messageStart.message.role}`)
  }

  // Must contain at least one content_block_start / content_block_stop pair
  const blockStarts = eventTypes.filter((e) => e === "content_block_start").length
  const blockStops = eventTypes.filter((e) => e === "content_block_stop").length
  if (blockStarts === 0) {
    throw new Error(`${label} expected at least one content_block_start event`)
  }
  if (blockStarts !== blockStops) {
    throw new Error(`${label} content_block_start (${blockStarts}) and content_block_stop (${blockStops}) count mismatch`)
  }

  // Must have message_delta before message_stop
  const messageDeltaIndex = eventTypes.lastIndexOf("message_delta")
  const messageStopIndex = eventTypes.lastIndexOf("message_stop")
  if (messageDeltaIndex === -1) {
    throw new Error(`${label} expected a message_delta event before message_stop`)
  }
  if (messageDeltaIndex >= messageStopIndex) {
    throw new Error(`${label} message_delta should come before message_stop`)
  }

  // Validate message_delta has stop_reason and usage
  const messageDelta = JSON.parse(events[messageDeltaIndex].data)
  if (!messageDelta.delta || typeof messageDelta.delta.stop_reason !== "string") {
    throw new Error(`${label} message_delta missing stop_reason`)
  }
  if (!messageDelta.usage || typeof messageDelta.usage.output_tokens !== "number") {
    throw new Error(`${label} message_delta missing usage.output_tokens`)
  }

  // Collect text from content_block_delta events
  const textDeltas = events
    .filter((e) => e.event === "content_block_delta")
    .map((e) => {
      const d = JSON.parse(e.data)
      if (d.delta?.type === "text_delta") return d.delta.text ?? ""
      return ""
    })
    .join("")

  // All data fields must be valid JSON
  for (const event of events) {
    try {
      JSON.parse(event.data)
    } catch {
      throw new Error(`${label} event "${event.event}" has invalid JSON data: ${event.data.slice(0, 120)}`)
    }
  }

  const preview = textDeltas.replace(/\s+/g, " ").slice(0, 120)
  console.log(`PASS ${label}: 200 stream OK (${events.length} events, ${blockStarts} blocks, text: "${preview}")`)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function prefixLines(value: string, prefix: string) {
  return value
    .split(/\r?\n/)
    .map((line, index, lines) => (line || index < lines.length - 1 ? `${prefix}${line}` : line))
    .join("\n")
}

export {}
