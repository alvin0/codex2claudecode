import { describe, expect, test } from "bun:test"
import { ToolCallCoordinator } from "../../src/core/tool-call-coordinator"

describe("ToolCallCoordinator", () => {
  test("registers and retrieves tool names", () => {
    const coord = new ToolCallCoordinator()
    coord.registerToolUse("call_1", "get_weather")
    expect(coord.getToolName("call_1")).toBe("get_weather")
    expect(coord.getToolName("unknown")).toBeUndefined()
  })

  test("accumulates fragmented tool input across multiple deltas", () => {
    const coord = new ToolCallCoordinator()
    coord.appendArgumentFragment("call_1", '{"ke')
    coord.appendArgumentFragment("call_1", 'y":"val')
    coord.appendArgumentFragment("call_1", 'ue"}')
    expect(coord.getAccumulatedArguments("call_1")).toBe('{"key":"value"}')
  })

  test("returns {} for malformed JSON arguments", () => {
    const coord = new ToolCallCoordinator()
    coord.appendArgumentFragment("call_1", '{"broken')
    expect(coord.getAccumulatedArguments("call_1")).toBe("{}")
  })

  test("returns {} for missing tool call arguments", () => {
    const coord = new ToolCallCoordinator()
    expect(coord.getAccumulatedArguments("unknown")).toBe("{}")
  })

  test("clears arguments after completion", () => {
    const coord = new ToolCallCoordinator()
    coord.appendArgumentFragment("call_1", '{"a":1}')
    coord.clearArguments("call_1")
    expect(coord.getAccumulatedArguments("call_1")).toBe("{}")
  })

  test("generates fallback IDs for missing tool use IDs", () => {
    const coord = new ToolCallCoordinator()
    const id1 = coord.resolveToolUseId(undefined)
    const id2 = coord.resolveToolUseId("")
    const id3 = coord.resolveToolUseId(null)
    expect(id1).toMatch(/^toolu_fallback_/)
    expect(id2).toMatch(/^toolu_fallback_/)
    expect(id1).not.toBe(id2)
    expect(id2).not.toBe(id3)
  })

  test("resolves valid tool use IDs unchanged", () => {
    const coord = new ToolCallCoordinator()
    expect(coord.resolveToolUseId("call_123")).toBe("call_123")
  })

  test("manages pending server calls", () => {
    const coord = new ToolCallCoordinator()
    expect(coord.hasPendingServerCalls()).toBe(false)

    coord.addPendingServerCall({ type: "web_search_call", id: "ws_1" })
    expect(coord.hasPendingServerCalls()).toBe(true)
    expect(coord.pendingServerCallCount).toBe(1)

    const calls = coord.takePendingServerCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ type: "web_search_call", id: "ws_1" })
    expect(coord.hasPendingServerCalls()).toBe(false)
  })

  test("defers text while server calls are pending", () => {
    const coord = new ToolCallCoordinator()
    expect(coord.hasDeferredText()).toBe(false)

    coord.deferText("hello ")
    coord.deferText("world")
    expect(coord.hasDeferredText()).toBe(true)

    const text = coord.takeDeferredText()
    expect(text).toBe("hello world")
    expect(coord.hasDeferredText()).toBe(false)
  })

  test("tracks registered tool count", () => {
    const coord = new ToolCallCoordinator()
    expect(coord.registeredToolCount).toBe(0)
    coord.registerToolUse("c1", "fn1")
    coord.registerToolUse("c2", "fn2")
    expect(coord.registeredToolCount).toBe(2)
  })
})
