import { describe, expect, test } from "bun:test"
import { findPublicIdentityViolations } from "../../../../script/scient-public-identity-check"

const validFiles = [
  {
    path: "README.md",
    contents: "# Scient Agent Source\nScientFactory/scient-agent\nnative Scient research agent\nanomalyco/opencode",
  },
  {
    path: "CONTRIBUTING.md",
    contents: "# Contributing to Scient Agent Source\nScientFactory/scient-desktop",
  },
  {
    path: "SECURITY.md",
    contents: "# Security policy\nhttps://github.com/ScientFactory/scient-agent/security/advisories/new",
  },
  { path: ".github/CODEOWNERS", contents: "* @yaacovcorcos" },
  { path: ".github/TEAM_MEMBERS", contents: "yaacovcorcos" },
  { path: ".github/ISSUE_TEMPLATE/bug-report.yml", contents: "Scient agent source revision" },
  { path: ".github/ISSUE_TEMPLATE/feature-request.yml", contents: "Native Scient agent capability" },
  {
    path: ".github/ISSUE_TEMPLATE/config.yml",
    contents: "https://github.com/ScientFactory/scient-desktop/issues",
  },
  {
    path: ".github/pull_request_template.md",
    contents: "### Boundaries\ninherited OpenCode lineage",
  },
  {
    path: "package.json",
    contents: JSON.stringify({ repository: { url: "https://github.com/ScientFactory/scient-agent" } }),
  },
]

describe("Scient public identity", () => {
  test("accepts the owned public boundary", () => {
    expect(findPublicIdentityViolations(validFiles)).toEqual([])
  })

  test("rejects upstream support and release links", () => {
    expect(
      findPublicIdentityViolations(
        validFiles.map((file) =>
          file.path === "README.md"
            ? { ...file, contents: `${file.contents}\nhttps://github.com/anomalyco/opencode/releases` }
            : file,
        ),
      ),
    ).toContainEqual({
      path: "README.md",
      message: "forbidden upstream public link or copy: github.com/anomalyco/opencode/releases",
    })
  })

  test("rejects upstream repository metadata", () => {
    expect(
      findPublicIdentityViolations(
        validFiles.map((file) =>
          file.path === "package.json"
            ? { ...file, contents: JSON.stringify({ repository: { url: "https://github.com/anomalyco/opencode" } }) }
            : file,
        ),
      ),
    ).toContainEqual({
      path: "package.json",
      message: "root repository URL must point to ScientFactory/scient-agent",
    })
  })
})
