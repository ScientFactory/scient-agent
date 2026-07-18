import { describe, expect, test } from "bun:test"

import { findWorkflowSafetyViolations } from "../../../../script/scient-workflow-check"

describe("Scient workflow safety check", () => {
  test("accepts owned workflows and isolated inherited workflows with immutable actions", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/scient-quality.yml",
          contents: `jobs:\n  quality:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@${"a".repeat(40)}\n      - uses: docker://alpine@sha256:${"b".repeat(64)}\n`,
        },
        {
          path: ".github/workflows/inherited.yml",
          contents:
            "jobs:\n  guarded:\n    if: |\n      github.repository == 'anomalyco/opencode' &&\n      (github.event_name == 'push' || github.event_name == 'pull_request')\n    steps:\n      - uses: ./.github/actions/setup-bun\n  disabled:\n    if: false\n    steps: []\n",
        },
      ]),
    ).toEqual([])
  })

  test("rejects unguarded inherited jobs and mutable external action references", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/inherited.yml",
          contents: "jobs:\n  unsafe:\n    steps:\n      - uses: actions/checkout@v4\n",
        },
      ]),
    ).toEqual([
      {
        path: ".github/workflows/inherited.yml",
        message: "external action is not pinned to a full commit SHA: actions/checkout@v4",
      },
      {
        path: ".github/workflows/inherited.yml",
        message: "inherited job unsafe must be disabled or guarded to an upstream repository",
      },
    ])
  })

  test("does not accept a guard that can run in the Scient repository", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/inherited.yml",
          contents:
            "jobs:\n  unsafe:\n    if: github.repository == 'anomalyco/opencode' || github.repository == 'ScientFactory/scient-agent'\n    steps: []\n",
        },
      ]),
    ).toHaveLength(1)
  })

  test("finds mutable action references in parsed inline and anchored YAML", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/inherited.yml",
          contents:
            "jobs:\n  guarded:\n    if: github.repository == 'anomalyco/opencode'\n    steps:\n      - { uses: actions/checkout@v4 }\n      - uses: &checkout actions/setup-node@v4\n",
        },
      ]),
    ).toEqual([
      {
        path: ".github/workflows/inherited.yml",
        message: "external action is not pinned to a full commit SHA: actions/checkout@v4",
      },
      {
        path: ".github/workflows/inherited.yml",
        message: "external action is not pinned to a full commit SHA: actions/setup-node@v4",
      },
    ])
  })

  test("requires container actions to use an immutable digest", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/scient-quality.yml",
          contents: "jobs:\n  quality:\n    steps:\n      - uses: docker://alpine:3.22\n",
        },
      ]),
    ).toEqual([
      {
        path: ".github/workflows/scient-quality.yml",
        message: "container action is not pinned to a sha256 digest: docker://alpine:3.22",
      },
    ])
  })

  test("requires Docker-based local actions to pin their image digest", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/actions/container/action.yml",
          contents: "runs:\n  using: docker\n  image: docker://alpine:3.22\n",
        },
      ]),
    ).toEqual([
      {
        path: ".github/actions/container/action.yml",
        message: "container action is not pinned to a sha256 digest: docker://alpine:3.22",
      },
    ])
  })

  test("matches Docker action syntax case-insensitively like the runner", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/actions/container/action.yml",
          contents: "runs:\n  using: Docker\n  image: DOCKER://alpine:3.22\n",
        },
      ]),
    ).toHaveLength(1)
  })

  test("rejects local actions outside the recursively scanned action directory", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/scient-quality.yml",
          contents: "jobs:\n  quality:\n    steps:\n      - uses: ./ci/setup\n",
        },
      ]),
    ).toEqual([
      {
        path: ".github/workflows/scient-quality.yml",
        message: "local reference must live under the recursively scanned .github/actions directory: ./ci/setup",
      },
    ])
  })

  test("rejects a local action path that escapes the scanned directory", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/scient-quality.yml",
          contents: "jobs:\n  quality:\n    steps:\n      - uses: ./.github/actions/../../ci/setup\n",
        },
      ]),
    ).toHaveLength(1)
  })

  test("accepts local reusable workflows and ignores unrelated uses fields", () => {
    expect(
      findWorkflowSafetyViolations([
        {
          path: ".github/workflows/scient-quality.yml",
          contents:
            "env:\n  uses: ubuntu-latest\njobs:\n  call:\n    uses: ./.github/workflows/reusable.yml\n",
        },
      ]),
    ).toEqual([])
  })
})
