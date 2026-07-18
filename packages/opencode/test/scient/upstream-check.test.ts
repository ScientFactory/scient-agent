import { describe, expect, test } from "bun:test"
import {
  githubRepositoryFromRemote,
  parseUpstreamState,
  resolveVerificationMode,
  shouldFetchUpstream,
  type UpstreamState,
} from "../../../../script/scient-upstream-check"

const validState = {
  schemaVersion: 1,
  ownedRepository: "ScientFactory/scient-agent",
  ownedDefaultBranch: "dev",
  officialRepository: "anomalyco/opencode",
  officialDefaultBranch: "dev",
  updateMode: "adapter-maintained",
  reviewedThrough: "a".repeat(40),
  reviewedAt: "2026-07-18",
  integrationBase: "b".repeat(40),
  reviewRecord: "ScientFactory/Scient:lab/external/upstream-reviews/2026-07-18-scient-agent.md",
} satisfies UpstreamState

describe("Scient upstream source check", () => {
  test("accepts equivalent GitHub SSH and HTTPS remote forms", () => {
    expect(githubRepositoryFromRemote("git@github.com:ScientFactory/scient-agent.git")).toBe(
      "scientfactory/scient-agent",
    )
    expect(githubRepositoryFromRemote("https://github.com/ScientFactory/scient-agent.git")).toBe(
      "scientfactory/scient-agent",
    )
    expect(githubRepositoryFromRemote("ssh://git@github.com/ScientFactory/scient-agent")).toBe(
      "scientfactory/scient-agent",
    )
  })

  test("rejects non-GitHub and malformed remotes", () => {
    expect(githubRepositoryFromRemote("https://example.com/owner/repo.git")).toBeNull()
    expect(githubRepositoryFromRemote("DISABLED")).toBeNull()
    expect(githubRepositoryFromRemote("")).toBeNull()
  })

  test("fetches upstream by default and requires an explicit offline opt-out", () => {
    expect(shouldFetchUpstream([])).toBe(true)
    expect(shouldFetchUpstream(["--intake"])).toBe(true)
    expect(shouldFetchUpstream(["--no-fetch"])).toBe(false)
  })

  test("uses explicit report, review, and intake modes", () => {
    expect(resolveVerificationMode([])).toBe("report")
    expect(resolveVerificationMode(["--review-check"])).toBe("review")
    expect(resolveVerificationMode(["--intake"])).toBe("intake")
    expect(resolveVerificationMode(["--checks"])).toBe("intake")
    expect(() => resolveVerificationMode(["--review-check", "--intake"])).toThrow(
      "either --review-check or --intake",
    )
  })

  test("validates machine-readable upstream review state", () => {
    expect(parseUpstreamState(validState)).toEqual(validState)
    expect(() => parseUpstreamState({ ...validState, reviewedThrough: "short" })).toThrow(
      "full lowercase commit SHA",
    )
    expect(() => parseUpstreamState({ ...validState, updateMode: "always-merge" })).toThrow(
      "unsupported updateMode",
    )
  })
})
