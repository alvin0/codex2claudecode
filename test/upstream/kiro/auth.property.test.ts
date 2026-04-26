import { describe, expect, test } from "bun:test"
import fc from "fast-check"

import { Kiro_Auth_Manager } from "../../../src/upstream/kiro"
import { mkdtemp, path, readFile, rm, tmpdir, writeFile } from "../../helpers"

function token(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "a",
    refreshToken: "r",
    expiresAt: new Date(Date.now() + 700_000).toISOString(),
    region: "us-east-1",
    ...overrides,
  }
}

async function withTempAuthFile(contents: Record<string, unknown>, callback: (file: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "kiro-auth-property-"))
  const file = path.join(dir, "kiro-auth-token.json")
  await writeFile(file, JSON.stringify(contents))
  try {
    await callback(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe("Kiro auth properties", () => {
  test("Property 1: auth field storage completeness", () => {
    fc.assert(fc.property(fc.option(fc.string(), { nil: undefined }), fc.option(fc.string(), { nil: undefined }), fc.option(fc.string(), { nil: undefined }), (clientIdHash, clientId, profileArn) => {
      const auth = new Kiro_Auth_Manager(token({ clientIdHash, clientId, clientSecret: clientId ? "secret" : undefined, profileArn }), "/tmp/unused")
      expect(auth.getRegion()).toBe("us-east-1")
      expect(auth.getProfileArn()).toBe(profileArn)
      expect(auth.getAuthType()).toBe(clientId ? "aws_sso_oidc" : "kiro_desktop")
    }), { numRuns: 100 })
  })

  test("Property 2: token expiration threshold correctness", () => {
    const originalNow = Date.now
    try {
      fc.assert(fc.property(fc.integer({ min: 1_700_000_000_000, max: 1_700_001_000_000 }), fc.integer({ min: -1000, max: 1000 }), (now, offsetSeconds) => {
        Date.now = () => now
        const expiresAt = new Date(now + offsetSeconds * 1000).toISOString()
        const auth = new Kiro_Auth_Manager(token({ expiresAt }), "/tmp/unused")
        expect(auth.isTokenExpired()).toBe(now >= Date.parse(expiresAt))
        expect(auth.isTokenExpiringSoon()).toBe(now >= Date.parse(expiresAt) - 600_000)
      }), { numRuns: 100 })
    } finally {
      Date.now = originalNow
    }
  })

  test("Property 3: auth type detection from credentials", () => {
    fc.assert(fc.property(fc.boolean(), fc.boolean(), (hasClientId, hasClientSecret) => {
      const auth = new Kiro_Auth_Manager(token({ ...(hasClientId ? { clientId: "id" } : {}), ...(hasClientSecret ? { clientSecret: "secret" } : {}) }), "/tmp/unused")
      expect(auth.getAuthType()).toBe(hasClientId && hasClientSecret ? "aws_sso_oidc" : "kiro_desktop")
    }), { numRuns: 100 })
  })

  test("Property 4: refresh response credential update", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 3600 }), async (expiresIn) => {
      await withTempAuthFile(token({ expiresAt: new Date(Date.now() - 1).toISOString() }), async (file) => {
        const auth = await Kiro_Auth_Manager.fromAuthFile(file, {
          fetch: (() => Promise.resolve(Response.json({ accessToken: "new", refreshToken: "new-r", expiresIn }))) as unknown as typeof fetch,
        })

        const before = Date.now()
        expect(await auth.getAccessToken()).toBe("new")
        const after = Date.now()
        const saved = JSON.parse(await readFile(file, "utf8")) as { expiresAt: string }
        const savedExpiry = Date.parse(saved.expiresAt)

        expect(savedExpiry).toBeGreaterThanOrEqual(before + expiresIn * 1000)
        expect(savedExpiry).toBeLessThanOrEqual(after + expiresIn * 1000)
      })
    }), { numRuns: 100 })
  })

  test("Property 5: credential file write-back preservation", async () => {
    await fc.assert(fc.asyncProperty(
      fc.option(fc.string(), { nil: undefined }),
      fc.boolean(),
      fc.boolean(),
      async (profileArn, keepFlag, updateProfileArn) => {
        const original = token({
          profileArn,
          keepFlag,
          customObject: { stable: true, marker: profileArn ?? "none" },
          expiresAt: new Date(Date.now() - 1).toISOString(),
        })

        await withTempAuthFile(original, async (file) => {
          const auth = await Kiro_Auth_Manager.fromAuthFile(file, {
            fetch: (() => Promise.resolve(Response.json({
              accessToken: "new-access",
              refreshToken: "new-refresh",
              expiresIn: 60,
              ...(updateProfileArn ? { profileArn: "arn:updated" } : {}),
            }))) as unknown as typeof fetch,
          })

          await auth.refresh()
          const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>

          expect(saved.accessToken).toBe("new-access")
          expect(saved.refreshToken).toBe("new-refresh")
          expect(saved.region).toBe("us-east-1")
          expect(saved.keepFlag).toBe(keepFlag)
          expect(saved.customObject).toEqual({ stable: true, marker: profileArn ?? "none" })
          expect(saved.profileArn).toBe(updateProfileArn ? "arn:updated" : profileArn)
        })
      },
    ), { numRuns: 100 })
  })
})
