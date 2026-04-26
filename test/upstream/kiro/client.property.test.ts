import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { MAX_RETRIES, X_AMZ_USER_AGENT_TEMPLATE } from "../../../src/upstream/kiro/constants"
import { Kiro_Auth_Manager, Kiro_Client } from "../../../src/upstream/kiro"

describe("Kiro client properties", () => {
  test("Property 6: request header completeness", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 99 }), fc.constantFrom("us-east-1", "us-west-2", "eu-central-1"), async (seed, region) => {
      let url = ""
      let headers = new Headers()
      const fingerprint = `fp${seed}`
      const kiroVersion = `1.${seed}.0`
      const auth = new Kiro_Auth_Manager({ accessToken: "access", refreshToken: "refresh", expiresAt: new Date(Date.now() + 700_000).toISOString(), region }, "/tmp/unused")
      const client = new Kiro_Client(auth, {
        fingerprint,
        kiroVersion,
        fetch: ((input, init) => {
          url = String(input)
          headers = new Headers(init?.headers)
          return Promise.resolve(new Response("{}"))
        }) as unknown as typeof fetch,
      })

      await client.generateAssistantResponse({
        conversationState: {
          conversationId: "id",
          currentMessage: { userInputMessage: { content: "hi", modelId: "m", origin: "AI_EDITOR" } },
          chatTriggerType: "MANUAL",
        },
      })

      expect(url).toBe("https://q.us-east-1.amazonaws.com/generateAssistantResponse")
      expect(headers.get("authorization")).toBe("Bearer access")
      expect(headers.get("content-type")).toBe("application/json")
      expect(headers.get("x-amzn-codewhisperer-optout")).toBe("true")
      expect(headers.get("x-amzn-kiro-agent-mode")).toBe("vibe")
      expect(headers.get("user-agent")).toContain(`os/${process.platform}#${process.version}`)
      expect(headers.get("user-agent")).toContain(`KiroIDE-${kiroVersion}-${fingerprint}`)
      expect(headers.get("x-amz-user-agent")).toBe(X_AMZ_USER_AGENT_TEMPLATE.replaceAll("{kiroVersion}", kiroVersion).replaceAll("{fingerprint}", fingerprint))
      expect(headers.get("amz-sdk-invocation-id")).toMatch(/^[0-9a-f-]{36}$/)
      expect(headers.get("amz-sdk-request")).toBe(`attempt=1; max=${MAX_RETRIES}`)
    }), { numRuns: 100 })
  })
})
