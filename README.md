# Scient Agent

The native research agent of [Scient](https://github.com/ScientFactory/scient-desktop).

Scient Agent is built from [Oh My Pi](https://github.com/can1357/oh-my-pi) and keeps its agent runtime: files, shell, code execution, Skills, MCP, subagents, background work, browser and LSP. It is a separate product with its own executable, state, configuration and updates, and it runs alongside a stock `omp` without sharing anything with it.

Scient Desktop runs it over the RPC protocol and manages its installation. To build or maintain it, read [SCIENT.md](SCIENT.md).

## License

MIT. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt). Oh My Pi is © Mario Zechner, Can Bölük and Stencil Labs, Inc.
