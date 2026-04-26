import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { buildProviderInfo } from "../../src/ui/provider-info"
import type { ProviderMode } from "../../src/ui/types"

describe("provider info properties", () => {
  test("buildProviderInfo produces correct mode and label", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ProviderMode>("codex", "kiro"),
        fc.constantFrom("kiro_desktop", "aws_sso_oidc"),
        fc.string(),
        fc.option(fc.string(), { nil: undefined }),
        (mode, authType, region, profileArn) => {
          const upstream =
            mode === "kiro"
              ? ({
                  getAuthType: () => authType,
                  getRegion: () => region,
                  getProfileArn: () => profileArn,
                } as any)
              : ({} as any)
          const info = buildProviderInfo(mode, upstream, "/auth.json")

          expect(info.mode).toBe(mode)
          expect(info.label).toBe(mode === "codex" ? "Codex" : "Kiro")
          if (mode === "kiro") {
            expect(info).toHaveProperty("authType")
            expect(info).toHaveProperty("region")
            expect(info).toHaveProperty("authFilePath")
          }
        },
      ),
    )
  })
})
