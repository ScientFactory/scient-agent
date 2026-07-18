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

## Before opening a pull request

1. Read [AGENTS.md](./AGENTS.md) and any more specific `AGENTS.md` file in the
   area you change.
2. Start from the current `dev` branch and use the branch and commit naming rules
   in `AGENTS.md`.
3. Keep ordinary Scient product work separate from upstream intake.
4. Add focused tests for behavior changes and run tests from the package that
   owns them.
5. Run the relevant repository checks:

   ```sh
   bun install --frozen-lockfile
   bun run scient:identity-check
   bun run scient:upstream-check
   bun turbo typecheck
   cd packages/opencode
   bun test
   bun run build
   ```

6. Explain the user or maintainer impact, verification performed, inherited
   compatibility implications, and any cross-repository dependency.

Small, reviewable pull requests are preferred. Security reports must use the
private process in [SECURITY.md](./SECURITY.md), not a public issue.
