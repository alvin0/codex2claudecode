import { describe, expect, test } from "bun:test"
import { ClaudeSseWriter } from "../../src/inbound/claude/sse-writer"

function createWriter() {
  const chunks: string[] = []
  const decoder = new TextDecoder()
  let controller!: ReadableStreamDefaultController<Uint8Array>

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })

  const writer = new ClaudeSseWriter(controller)

  async function collectEvents(): Promise<Array<{ event: string; data: Record<string, any> }>> {
    writer.close()
    const reader = stream.getReader()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    buffer += decoder.decode()

    return buffer
      .split("\n\n")
      .filter((block) => block.trim())
      .map((block) => {
        const eventLine = block.split("\n").find((l) => l.startsWith("event:"))
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"))
        return {
          event: eventLine?.slice(7) ?? "",
          data: dataLine ? JSON.parse(dataLine.slice(5).trim()) : undefined,
        }
      })
  }

  return { writer, collectEvents }
}

describe("ClaudeSseWriter", () => {
  test("emits exact event: <type>\\ndata: <json>\\n\\n framing", async () => {
    const { writer, collectEvents } = createWriter()
    writer.ping()
    const events = await collectEvents()

    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("ping")
    expect(events[0].data).toEqual({ type: "ping" })
  })

  test("messageStart emits message_start event", async () => {
    const { writer, collectEvents } = createWriter()
    writer.messageStart({ id: "msg_1", type: "message", role: "assistant", model: "test", content: [] })
    const events = await collectEvents()

    expect(events).toHaveLength(1)
    expect(events[0].event).toBe("message_start")
    expect(events[0].data.type).toBe("message_start")
    expect(events[0].data.message.id).toBe("msg_1")
  })

  test("text block lifecycle: start, delta, stop", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startTextBlock()
    writer.textDelta("hello")
    writer.stopTextBlock()
    const events = await collectEvents()

    expect(events).toHaveLength(3)
    expect(events[0].event).toBe("content_block_start")
    expect(events[0].data.content_block.type).toBe("text")
    expect(events[0].data.index).toBe(0)
    expect(events[1].event).toBe("content_block_delta")
    expect(events[1].data.delta.text).toBe("hello")
    expect(events[2].event).toBe("content_block_stop")
    expect(events[2].data.index).toBe(0)
  })

  test("thinking block lifecycle with signature", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startThinkingBlock("sig_abc")
    writer.thinkingDelta("thinking...")
    writer.stopThinkingBlock("sig_abc")
    const events = await collectEvents()

    expect(events).toHaveLength(4)
    expect(events[0].data.content_block.type).toBe("thinking")
    expect(events[0].data.content_block.signature).toBe("sig_abc")
    expect(events[1].data.delta.thinking).toBe("thinking...")
    expect(events[2].data.delta.type).toBe("signature_delta")
    expect(events[2].data.delta.signature).toBe("sig_abc")
    expect(events[3].event).toBe("content_block_stop")
  })

  test("error after open thinking block closes the block before error", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startThinkingBlock("sig_1")
    writer.thinkingDelta("partial thinking")
    writer.closeOpenBlocks("sig_1")
    writer.error({ type: "error", error: { type: "api_error", message: "fail" } })
    const events = await collectEvents()

    // thinking_start, thinking_delta, signature_delta, block_stop, error
    const eventTypes = events.map((e) => e.event)
    expect(eventTypes).toContain("content_block_stop")
    expect(eventTypes).toContain("error")
    const stopIdx = eventTypes.indexOf("content_block_stop")
    const errorIdx = eventTypes.indexOf("error")
    expect(stopIdx).toBeLessThan(errorIdx)
  })

  test("error after open text block closes the block before error", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startTextBlock()
    writer.textDelta("partial")
    writer.closeOpenBlocks()
    writer.error({ type: "error", error: { type: "api_error", message: "fail" } })
    const events = await collectEvents()

    const eventTypes = events.map((e) => e.event)
    const stopIdx = eventTypes.lastIndexOf("content_block_stop")
    const errorIdx = eventTypes.indexOf("error")
    expect(stopIdx).toBeLessThan(errorIdx)
  })

  test("error after server tool block does not reuse emitted index", async () => {
    const { writer, collectEvents } = createWriter()
    writer.serverToolBlocks([
      { type: "server_tool_use", id: "st_1", name: "web_search", input: { query: "test" } },
    ])
    const indexAfterServerTool = writer.nextContentIndex()
    writer.closeOpenBlocks()
    writer.error({ type: "error", error: { type: "api_error", message: "fail" } })
    const events = await collectEvents()

    // Server tool block used index 0, so next should be 1
    expect(indexAfterServerTool).toBe(1)
    // No content_block_start should use index 0 after the server tool block
    const startEvents = events.filter((e) => e.event === "content_block_start")
    expect(startEvents).toHaveLength(1)
    expect(startEvents[0].data.index).toBe(0)
  })

  test("toolUseBlock emits complete tool_use lifecycle", async () => {
    const { writer, collectEvents } = createWriter()
    writer.toolUseBlock("call_1", "get_weather", '{"city":"NYC"}')
    const events = await collectEvents()

    expect(events).toHaveLength(4)
    expect(events[0].data.content_block.type).toBe("tool_use")
    expect(events[0].data.content_block.id).toBe("call_1")
    expect(events[0].data.content_block.name).toBe("get_weather")
    expect(events[1].data.delta.partial_json).toBe("")
    expect(events[2].data.delta.partial_json).toBe('{"city":"NYC"}')
    expect(events[3].event).toBe("content_block_stop")
  })

  test("content index increments correctly across block types", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startThinkingBlock("sig")
    writer.stopThinkingBlock("sig")
    writer.startTextBlock()
    writer.stopTextBlock()
    writer.toolUseBlock("c1", "fn", "{}")
    const events = await collectEvents()

    const starts = events.filter((e) => e.event === "content_block_start")
    expect(starts[0].data.index).toBe(0) // thinking
    expect(starts[1].data.index).toBe(1) // text
    expect(starts[2].data.index).toBe(2) // tool_use
  })

  test("startTextBlock is idempotent", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startTextBlock()
    writer.startTextBlock()
    writer.textDelta("hello")
    writer.stopTextBlock()
    const events = await collectEvents()

    const starts = events.filter((e) => e.event === "content_block_start")
    expect(starts).toHaveLength(1)
  })

  test("stopTextBlock is idempotent", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startTextBlock()
    writer.stopTextBlock()
    writer.stopTextBlock()
    const events = await collectEvents()

    const stops = events.filter((e) => e.event === "content_block_stop")
    expect(stops).toHaveLength(1)
  })

  test("unknown events do not break SSE framing", async () => {
    const { writer, collectEvents } = createWriter()
    writer.startTextBlock()
    writer.textDelta("hello")
    writer.send("custom_event", { type: "custom" })
    writer.stopTextBlock()
    const events = await collectEvents()

    expect(events).toHaveLength(4)
    expect(events[2].event).toBe("custom_event")
  })

  test("messageDelta and messageStop emit correct events", async () => {
    const { writer, collectEvents } = createWriter()
    writer.messageDelta("end_turn", { input_tokens: 100, output_tokens: 50 })
    writer.messageStop()
    const events = await collectEvents()

    expect(events).toHaveLength(2)
    expect(events[0].event).toBe("message_delta")
    expect(events[0].data.delta.stop_reason).toBe("end_turn")
    expect(events[1].event).toBe("message_stop")
  })

  test("server tool blocks with mcp_tool_use include server_name", async () => {
    const { writer, collectEvents } = createWriter()
    writer.serverToolBlocks([
      { type: "mcp_tool_use", id: "mcp_1", name: "tool", server_name: "my-server", input: { key: "val" } },
    ])
    const events = await collectEvents()

    const start = events.find((e) => e.event === "content_block_start")
    expect(start?.data.content_block.server_name).toBe("my-server")
  })

  test("closeOpenBlocks with no open blocks is safe", async () => {
    const { writer, collectEvents } = createWriter()
    writer.closeOpenBlocks()
    const events = await collectEvents()
    expect(events).toHaveLength(0)
  })

  test("close prevents further sends", async () => {
    const { writer, collectEvents } = createWriter()
    writer.ping()
    writer.close()
    writer.ping() // should be ignored
    const events = await collectEvents()
    expect(events).toHaveLength(1)
  })
})
