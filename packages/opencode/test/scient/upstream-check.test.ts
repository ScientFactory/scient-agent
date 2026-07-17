import { describe, expect, test } from "bun:test"
import {
  assertCurrentUpstream,
  githubRepositoryFromRemote,
  shouldFetchUpstream,
} from "../../../../script/scient-upstream-check"

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
    expect(shouldFetchUpstream(["--checks"])).toBe(true)
    expect(shouldFetchUpstream(["--no-fetch"])).toBe(false)
  })

  test("rejects a behind fork unless diagnostic mode is explicit", () => {
    expect(() => assertCurrentUpstream("0", [])).not.toThrow()
    expect(() => assertCurrentUpstream("2", [])).toThrow("2 commit(s) behind upstream/dev")
    expect(() => assertCurrentUpstream("2", ["--allow-behind"])).not.toThrow()
  })
})
