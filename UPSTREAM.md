# Upstream maintenance

This is the ScientFactory-owned source foundation for the native Scient agent.
OpenCode is a read-only source of optional improvements; it does not control
Scient's product direction, identity, or release schedule.

- Owned branch: `ScientFactory/scient-agent`, `dev`
- Official reference: `anomalyco/opencode`, `dev`
- Writable remote: `origin`
- Fetch-only remote: `upstream` with push URL `DISABLED`
- Machine review state: `upstream-state.json`
- Canonical policy: `Scient/docs/operations/upstream-intake.md`

Use `bun run scient:upstream-check` for topology, divergence, and review-state
reporting without treating new official changes as a product-CI failure. Use
`--require-reviewed-tip` when closing a disposition review; the compatibility
alias `--review-check` is equally strict. Use `--intake` from a clean
maintenance branch to run the deterministic source suite before proposing
inherited code.

Being behind official OpenCode is not itself a failure. Unreviewed movement
must be surfaced, classified, and dispositioned. Upstream intake must not be
mixed with ordinary Scient product work. Preserve the separation between
inherited core and Scient capabilities, as well as Scient identity,
configuration, credentials, sessions, permissions, and external OpenCode.
Run a cross-repository desktop smoke when a protocol, runtime, session,
approval, tool-event, or shared contract changes.
