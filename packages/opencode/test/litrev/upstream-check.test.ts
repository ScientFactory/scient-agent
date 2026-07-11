import { describe, expect, test } from "bun:test"
import { githubRepositoryFromRemote, shouldFetchUpstream } from "../../../../script/litrev-upstream-check"

describe("LitRev upstream source check", () => {
  test("accepts equivalent GitHub SSH and HTTPS remote forms", () => {
    expect(githubRepositoryFromRemote("git@github.com:yaacovcorcos/opencode.git")).toBe("yaacovcorcos/opencode")
    expect(githubRepositoryFromRemote("https://github.com/yaacovcorcos/opencode.git")).toBe("yaacovcorcos/opencode")
    expect(githubRepositoryFromRemote("ssh://git@github.com/yaacovcorcos/opencode")).toBe("yaacovcorcos/opencode")
  })

  test("rejects non-GitHub and malformed remotes", () => {
    expect(githubRepositoryFromRemote("https://example.com/owner/repo.git")).toBeNull()
    expect(githubRepositoryFromRemote("DISABLED")).toBeNull()
    expect(githubRepositoryFromRemote("")).toBeNull()
  })

  test("fetches upstream by default and requires an explicit offline opt-out", () => {
    expect(shouldFetchUpstream([])).toBe(true)
    expect(shouldFetchUpstream(["--checks"])).toBe(true)
    expect(shouldFetchUpstream(["--no-fetch"])).toBe(false)
  })
})
