import { describe, expect, test } from "bun:test"

import { buildProviderInfo } from "../../src/ui/provider-info"

describe("provider info", () => {
  test("builds Codex provider info", () => {
    expect(buildProviderInfo("codex", {} as any)).toEqual({ mode: "codex", label: "Codex" })
  })

  test("builds Kiro desktop auth provider info", () => {
    expect(
      buildProviderInfo(
        "kiro",
        {
          getAuthType: () => "kiro_desktop",
          getRegion: () => "us-east-1",
          getProfileArn: () => "arn:aws:kiro:profile",
        } as any,
        "/path/to/auth.json",
      ),
    ).toEqual({
      mode: "kiro",
      label: "Kiro",
      authType: "Desktop Auth",
      region: "us-east-1",
      profileArn: "arn:aws:kiro:profile",
      authFilePath: "/path/to/auth.json",
    })
  })

  test("builds Kiro SSO OIDC provider info", () => {
    expect(
      buildProviderInfo(
        "kiro",
        {
          getAuthType: () => "aws_sso_oidc",
          getRegion: () => "eu-west-1",
          getProfileArn: () => undefined,
        } as any,
        "/path",
      ),
    ).toEqual({
      mode: "kiro",
      label: "Kiro",
      authType: "SSO OIDC",
      region: "eu-west-1",
      authFilePath: "/path",
    })
  })

  test("falls back gracefully when Kiro methods are unavailable", () => {
    expect(buildProviderInfo("kiro", {} as any)).toEqual({
      mode: "kiro",
      label: "Kiro",
      authType: "Desktop Auth",
      region: "unknown",
      authFilePath: "",
    })
  })
})
