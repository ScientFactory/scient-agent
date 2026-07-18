import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  assertGitHubRemote,
  assertReviewCurrent,
  assertUpstreamPushDisabled,
  githubRepositoryFromRemote,
  parseUpstreamState,
  resolveVerificationMode,
  shouldFetchUpstream,
  verifyAncestry,
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

  test("rejects the wrong owned repository and any writable upstream push URL", () => {
    expect(() =>
      assertGitHubRemote(
        "origin fetch URL",
        "git@github.com:ScientFactory/scient-agent.git",
        "ScientFactory/scient-agent",
      ),
    ).not.toThrow()
    expect(() =>
      assertGitHubRemote("origin fetch URL", "https://github.com/anomalyco/opencode.git", "ScientFactory/scient-agent"),
    ).toThrow("origin fetch URL mismatch")
    expect(() => assertUpstreamPushDisabled("DISABLED")).not.toThrow()
    expect(() => assertUpstreamPushDisabled("git@github.com:anomalyco/opencode.git")).toThrow("expected DISABLED")
  })

  test("fetches upstream by default and requires an explicit offline opt-out", () => {
    expect(shouldFetchUpstream([])).toBe(true)
    expect(shouldFetchUpstream(["--intake"])).toBe(true)
    expect(shouldFetchUpstream(["--no-fetch"])).toBe(false)
  })

  test("uses explicit report, review, and intake modes", () => {
    expect(resolveVerificationMode([])).toBe("report")
    expect(resolveVerificationMode(["--review-check"])).toBe("review")
    expect(resolveVerificationMode(["--require-reviewed-tip"])).toBe("review")
    expect(resolveVerificationMode(["--intake"])).toBe("intake")
    expect(resolveVerificationMode(["--checks"])).toBe("intake")
    expect(() => resolveVerificationMode(["--review-check", "--intake"])).toThrow(
      "either strict review verification or --intake",
    )
  })

  test("requires the reviewed checkpoint to equal the official tip only in strict review mode", () => {
    expect(() => assertReviewCurrent("report", 2, "a".repeat(40), "b".repeat(40))).not.toThrow()
    expect(() => assertReviewCurrent("intake", 2, "a".repeat(40), "b".repeat(40))).not.toThrow()
    expect(() => assertReviewCurrent("review", 0, "a".repeat(40), "a".repeat(40))).not.toThrow()
    expect(() => assertReviewCurrent("review", 2, "a".repeat(40), "b".repeat(40))).toThrow("leaves 2 unreviewed commit")
  })

  test("validates machine-readable upstream review state", () => {
    expect(parseUpstreamState(validState)).toEqual(validState)
    expect(() => parseUpstreamState({ ...validState, reviewedThrough: "short" })).toThrow("full lowercase commit SHA")
    expect(() => parseUpstreamState({ ...validState, updateMode: "always-merge" })).toThrow("unsupported updateMode")
  })

  test("proves valid review and integration ancestry in a real Git repository", () => {
    const fixture = createAncestryFixture()
    try {
      expect(() =>
        verifyAncestry({
          reviewedThrough: fixture.reviewed,
          integrationBase: fixture.base,
          upstreamTip: fixture.upstreamTip,
          ownedHead: fixture.owned,
          cwd: fixture.cwd,
        }),
      ).not.toThrow()
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true })
    }
  })

  test("rejects review and integration checkpoints on the wrong histories", () => {
    const fixture = createAncestryFixture()
    try {
      expect(() =>
        verifyAncestry({
          reviewedThrough: fixture.reviewed,
          integrationBase: fixture.owned,
          upstreamTip: fixture.upstreamTip,
          ownedHead: fixture.owned,
          cwd: fixture.cwd,
        }),
      ).toThrow("Integration base is not official upstream history")
      expect(() =>
        verifyAncestry({
          reviewedThrough: fixture.owned,
          integrationBase: fixture.base,
          upstreamTip: fixture.upstreamTip,
          ownedHead: fixture.owned,
          cwd: fixture.cwd,
        }),
      ).toThrow("Invalid upstream review checkpoint")
      expect(() =>
        verifyAncestry({
          reviewedThrough: fixture.reviewed,
          integrationBase: fixture.reviewed,
          upstreamTip: fixture.upstreamTip,
          ownedHead: fixture.owned,
          cwd: fixture.cwd,
        }),
      ).toThrow("Integration base is not present in owned history")
      expect(() =>
        verifyAncestry({
          reviewedThrough: "f".repeat(40),
          integrationBase: fixture.base,
          upstreamTip: fixture.upstreamTip,
          ownedHead: fixture.owned,
          cwd: fixture.cwd,
        }),
      ).toThrow("cat-file")
    } finally {
      rmSync(fixture.cwd, { recursive: true, force: true })
    }
  })
})

function createAncestryFixture() {
  const cwd = mkdtempSync(path.join(tmpdir(), "scient-agent-upstream-"))
  git(cwd, "init", "--initial-branch=owned")
  git(cwd, "config", "user.email", "scient-test@users.noreply.github.com")
  git(cwd, "config", "user.name", "Scient Test")
  git(cwd, "config", "commit.gpgsign", "false")
  const base = commit(cwd, "base.txt", "base")
  git(cwd, "branch", "official")
  const owned = commit(cwd, "owned.txt", "owned")
  git(cwd, "checkout", "official")
  const reviewed = commit(cwd, "reviewed.txt", "reviewed")
  const upstreamTip = commit(cwd, "tip.txt", "tip")
  return { cwd, base, owned, reviewed, upstreamTip }
}

function commit(cwd: string, file: string, contents: string) {
  writeFileSync(path.join(cwd, file), contents)
  git(cwd, "add", file)
  git(cwd, "commit", "-m", file)
  return git(cwd, "rev-parse", "HEAD")
}

function git(cwd: string, ...args: readonly string[]) {
  return execFileSync("git", [...args], { cwd, encoding: "utf8" }).trim()
}
