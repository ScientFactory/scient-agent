# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through the
[Scient agent security advisory form](https://github.com/ScientFactory/scient-agent/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability or include secrets,
credentials, private repositories, or sensitive logs in a report.

Include the affected revision, platform, configuration, reproduction steps,
expected impact, and the smallest safe proof available. Clearly say whether the
issue also reproduces in official OpenCode. A vulnerability that affects both
projects may need coordinated reporting, but ScientFactory remains responsible
for evaluating its owned source and release boundary.

## Current security boundary

This repository is an OpenCode-derived source foundation for the planned native
Scient agent. It is not yet a released native Scient agent.

The inherited agent core can execute shell commands, read and write files, use
network tools, and connect to configured providers. Its permission prompts are
an interaction and approval mechanism, not a security sandbox. Use an operating
system account, container, or virtual machine when stronger isolation is
required.

Server mode is opt-in. Any exposed server must use authentication and an
appropriately restricted network boundary. Provider and MCP-server behavior
remain governed by the services the operator chooses.

ScientFactory security decisions, credentials, sessions, permissions, and
scientific project truth must remain separate from upstream service or account
state.
