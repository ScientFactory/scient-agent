import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { XdProtocolHandler } from "../../src/internal-urls/xd-protocol";
import { evalPromptToolNames } from "../../src/scient/xdev-catalog";
import type { Tool, ToolSession } from "../../src/tools";
import { planXdevPromptDocs, renderXdevPromptDocs, xdevListing, type XdevState } from "../../src/tools/xdev";

function fixture() {
	const calls: string[] = [];
	const tools: Array<Tool & { mcpServerName: string; mcpServerDescription: string; mcpToolName: string }> = Array.from(
		{ length: 703 },
		(_, index) => ({
			name: `github__tool_${index}`,
			mcpServerName: "GitHub",
			mcpServerDescription: "Repositories, issues and pull requests.",
			mcpToolName: `github.tool_${index}`,
			label: "GitHub",
			description: "Search repository records.",
			parameters: type({ query: "string" }),
			execute: async (_id: string, args: { query: string }) => {
				calls.push(args.query);
				return { content: [{ type: "text" as const, text: args.query }] };
			},
		}),
	);
	const state: XdevState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(),
		isActive: () => false,
	};
	const session = { xdev: state } as ToolSession;
	return { calls, state, session, handler: new XdProtocolHandler() };
}

it("lists 703 tools once per service and preserves schema discovery and execution", async () => {
	const { state, session, handler, calls } = fixture();
	const docs = renderXdevPromptDocs(planXdevPromptDocs(state, "catalog"));
	expect(docs.match(/703 tools/g)).toHaveLength(1);
	expect(docs).not.toContain("github__tool_0");
	expect(xdevListing(state)).toContain("xd://services/github");
	session.getAdvertisedEvalToolNames = () => ["bash", "github__tool_0"];
	expect(evalPromptToolNames(session)).toEqual(["bash"]);
	const listing = await handler.resolve(parseInternalUrl("xd://services/github"), { session });
	expect(listing.content).toContain("github.tool_702 → xd://github__tool_702");
	const toolDocs = await handler.resolve(parseInternalUrl("xd://github__tool_702"), { session });
	expect(toolDocs.content).toContain("query: string");
	const executed = await handler.write(
		parseInternalUrl("xd://github__tool_702"),
		JSON.stringify({ query: "scient" }),
		{ session, toolCall: { id: "call" } },
	);
	expect(executed.content).toEqual([{ type: "text", text: "scient" }]);
	expect(calls).toEqual(["scient"]);
});

it("keeps service URLs read-only, rejects stale services, and follows the mounted roster", async () => {
	const { state, session, handler, calls } = fixture();
	const context = { session, toolCall: { id: "call" } };
	await expect(handler.write(parseInternalUrl("xd://services/github"), "{}", context)).rejects.toThrow();
	state.mountedNames.delete("github__tool_702");
	const listing = await handler.resolve(parseInternalUrl("xd://services/github"), { session });
	expect(listing.content).not.toContain("github__tool_702");
	state.mountedNames.clear();
	await expect(handler.resolve(parseInternalUrl("xd://services/github"), { session })).rejects.toThrow(
		"No mounted tools",
	);
	expect(calls).toEqual([]);
});

it("preserves explicit inline docs and encodes service names without changing execution names", async () => {
	const { state, session, handler } = fixture();
	const tool = state.tools.get("github__tool_0")!;
	state.tools.set(tool.name, Object.assign(tool, { mcpServerName: "Drive / Research" }));
	state.mountedNames.clear();
	state.mountedNames.add(tool.name);
	const catalog = renderXdevPromptDocs(planXdevPromptDocs(state, "catalog"));
	expect(catalog).toContain(
		"- services/drive%20%2F%20research — Drive / Research — Repositories, issues and pull requests: 1 tool: github__tool_0.",
	);
	const listing = await handler.resolve(parseInternalUrl("xd://services/drive%20%2F%20research"), { session });
	expect(listing.content).toContain("xd://github__tool_0");
	const inline = renderXdevPromptDocs(planXdevPromptDocs(state, "inline"));
	expect(inline).toContain("query: string");
	expect(inline).not.toContain("services/");
});

it("lists a service's tool names while they fit and describes every service", () => {
	const { state } = fixture();
	for (let index = 0; index < 3; index++) {
		const name = `scient_tool_${index}`;
		state.tools.set(name, {
			...state.tools.get("github__tool_0")!,
			name,
			mcpServerName: "Scient",
			mcpServerDescription: "Scient workspace tools.",
			mcpToolName: name,
		} as Tool);
		state.mountedNames.add(name);
	}
	const docs = renderXdevPromptDocs(planXdevPromptDocs(state, "catalog"));
	expect(docs).toContain(
		"- services/scient — Scient — Scient workspace tools: 3 tools: scient_tool_0, scient_tool_1, scient_tool_2.",
	);
	expect(docs).toContain(
		"GitHub — Repositories, issues and pull requests: 703 tools; read xd://services/github to choose one.",
	);
});

it("leaves a server that does not describe itself to upstream's per-tool lines", () => {
	const { state } = fixture();
	for (const tool of state.tools.values()) delete (tool as { mcpServerDescription?: string }).mcpServerDescription;
	const docs = renderXdevPromptDocs(planXdevPromptDocs(state, "catalog"));
	expect(docs).not.toContain("services/");
	expect(docs).toContain("- github__tool_0 — Search repository records.");
});
