# Contributing to Scient Agent Source

Thank you for contributing to the ScientFactory-owned source foundation for the
planned native Scient agent.

## Choose the correct repository

- Use this repository for inherited agent-core reliability, security,
  compatibility, provider, protocol, and bounded native-agent source work.
- Use `ScientFactory/scient-desktop` for the current desktop application.
- Product direction and cross-repository architecture belong in the private
  `ScientFactory/Scient` parent repository.
- Changes intended only for official OpenCode should be proposed to
  [`anomalyco/opencode`](https://github.com/anomalyco/opencode).

The native Scient agent is not yet a finished released product. Do not present
planned Scient behavior as implemented, and do not broadly rename inherited
OpenCode packages or compatibility identifiers without an accepted migration
boundary.

## Pull request flow

1. Read [AGENTS.md](./AGENTS.md) and any more specific `AGENTS.md` file in the
   area you change.
2. Start from the current `dev` branch and use the branch and commit naming rules
   in `AGENTS.md`.
3. Keep ordinary Scient product work separate from upstream intake.
4. Add focused tests for behavior changes and run tests from the package that
   owns them.
5. Open a draft pull request early when hosted checks or collaborator feedback
   will help. Before marking it ready, run the relevant repository checks:

   ```sh
   bun install --frozen-lockfile
   bun run scient:identity-check
   bun run scient:upstream-check
   bun turbo typecheck
   cd packages/opencode
   bun test
   bun run build
   ```

6. Complete Quality Review against the candidate diff and record its findings
   and dispositions.
7. Have a human exercise changed user-facing behavior. A user-visible UI or
   interaction change requires human inspection of the rendered candidate;
   automated or agent-operated evidence does not replace that judgment. If a
   human cannot inspect it, the change is not integration-ready.
8. Complete Integration Readiness Review against the exact final head, then
   explain the user or maintainer impact, verification performed, inherited
   compatibility implications, and any cross-repository dependency.

Small, reviewable pull requests are preferred. Security reports must use the
private process in [SECURITY.md](./SECURITY.md), not a public issue.

## Quality Review

Before presenting a pull request as ready, establish its intended outcome and
acceptance criteria, then inspect the complete candidate diff, affected tests,
and documentation. Start with reuse, quality, and efficiency: prefer suitable
existing primitives, preserve ownership and dependency direction, and examine
failure, concurrency, hot-path, no-op, cleanup, and resource-lifetime behavior.

These are prompts, not limits. Follow any material concern revealed by the
change, record each finding's disposition, and remain accountable for
agent-assisted work.

## Integration Readiness Review

Before merge, inspect the exact final head in its current `dev` context,
including its intent, inherited lineage, compatibility, dependencies, evidence,
conversations, and promotion impact. Follow relevant correctness, reliability,
data-loss, security, destructive-operation, architecture, product, UX, and test
risks without treating those topics as boundaries.

Investigate broadly and report precisely. Validate an alleged defect against
the current code and evidence with a concrete trigger, affected invariant,
observable impact, and root cause. For other material findings, name the
relevant principle and practical consequence. Keep missing evidence distinct
from a proven defect, state material uncertainty, and consolidate duplicate
symptoms.

Treat tests, fixtures, and workflows as evidence-bearing code. Confirm that
green results were not obtained by weakening assertions, removing meaningful
cases, making required checks conditional or non-blocking, or merely changing
fixtures to accept the new output. Intentional verification-gate changes must
be explicit and justified.

When separate perspectives would improve confidence and capable review agents
are available, use them independently and read-only for distinct concerns, then
reconcile their findings. Reviewer arrangement is risk-based, not fixed.

Record an integration-ready, not-integration-ready, or blocked verdict. Recheck
only what later changes could invalidate, but issue the final verdict for the
new head. One proportional pass may satisfy both stages for a small unchanged
candidate. Peer review is useful but not a default non-author approval gate.
