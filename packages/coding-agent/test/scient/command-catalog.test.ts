import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { evalPromptToolNames, projectCommandServices, serviceCommandDocs } from "../../src/scient/command-catalog";
import type { Tool } from "../../src/tools";
import {
	planToolCommandPromptDocs,
	renderToolCommandPromptDocs,
	type ToolCommandState,
} from "../../src/tools/tool-commands";

const parameters = type({ query: "string" });
function tool(name: string, server: string, description = server + ", a Scient connector") {
	return {
		name,
		label: server,
		description: "Find records in the connected service.",
		parameters,
		mcpServerName: server,
		mcpServerDescription: description,
		mcpToolName: name,
		async execute() {
			return { content: [] };
		},
	};
}

function commands(tools: Tool[], read = true): ToolCommandState {
	return {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(),
		isActive: name => read && name === "read",
	};
}

function catalog(state: ToolCommandState) {
	return projectCommandServices(state, () => ({
		sections: [],
		catalog: new Map([...state.tools].map(([name, tool]) => [name, tool.description])),
	}));
}

it("admits whole name lists at the UTF-8 row and total boundaries, counting separators", () => {
	// Multi-byte input to the projection also guards its byte contract independently of shell name validation.
	const first = tool("é".repeat(1_998), "First");
	const second = tool("aa", "First"); // 3996 + 2 for ", " + 2 = 4000
	const tooLarge = tool("s".repeat(4_001), "Too large");
	const last = tool("z".repeat(4_000), "Last");
	const overflow = tool("small", "Overflow");
	const state = commands([first, second, tooLarge, last, overflow]);
	const { section } = catalog(state);
	expect(section).toContain(first.name + ", " + second.name);
	expect(section).not.toContain(tooLarge.name);
	expect(section).toContain("help://services/too%20large");
	expect(section).toContain(last.name);
	expect(section).not.toContain(overflow.name);
	expect(section).toContain("help://services/overflow");
});

it("retains ordinary rows and explicit inline help, and falls back to per-command discovery without read", () => {
	const grouped = tool("drive_find", "Drive");
	const inline = tool("drive_list", "Drive");
	const ordinary = tool("other_find", "Other", "  ");
	const unnamed = tool("local_find", "  ", "Workspace");
	const state = commands([grouped, inline, ordinary, unnamed]);
	const docs = planToolCommandPromptDocs(state, "builtins", ["drive_list"]);
	const { section, names } = projectCommandServices(state, () => docs);
	expect([...names]).toEqual([grouped.name]);
	expect(section).toContain(grouped.name);
	const upstream = renderToolCommandPromptDocs(docs, names);
	expect(upstream).toContain("## drive_list");
	expect(upstream).toContain("--query");
	expect(upstream).toContain("`other_find`");
	expect(upstream).not.toContain(grouped.name);
	const withoutRead = catalog(commands([grouped], false));
	expect(withoutRead.section).toBe("");
	expect(withoutRead.names.size).toBe(0);
});

it("omits grouped commands and their wire aliases from eval while preserving ungrouped and shadowing names", () => {
	const state = commands([
		{ ...tool("mounted", "A"), customWireName: "alias" },
		{ ...tool("other", "B"), customWireName: "direct" },
		{ ...tool("inline", "A"), customWireName: "inline_alias" },
		tool("ordinary", "C", " "),
	]);
	state.tools.set("direct", tool("direct", "C"));
	const names = ["alias", "mounted", "other", "direct", "inline", "inline_alias", "ordinary"];
	expect(evalPromptToolNames(names, state, () => planToolCommandPromptDocs(state, "builtins", ["inline"]))).toEqual([
		"direct",
		"inline",
		"inline_alias",
		"ordinary",
	]);
});

it("describes 200 mounted connector commands in 15 rows", () => {
	const servers = [
		"github",
		"jira",
		"confluence",
		"slack",
		"drive",
		"gmail",
		"calendar",
		"notion",
		"linear",
		"figma",
		"dropbox",
		"salesforce",
		"hubspot",
		"airtable",
		"zendesk",
	];
	const verbs = ["search", "list", "get", "create", "update", "delete"];
	const nouns = ["records", "comments", "files"];
	const tools = servers.flatMap((server, index) =>
		Array.from({ length: index < 5 ? 14 : 13 }, (_, i) =>
			tool(server + "__" + verbs[i % 6] + "_" + nouns[Math.floor(i / 6)], server),
		),
	);
	const { section } = catalog(commands(tools));
	expect(section.match(/help:\/\/services\//g)).toHaveLength(15);
	for (const command of tools) expect(section).toContain(command.name);
	process.stdout.write(
		`Service catalog (15 services, 200 commands): ${Buffer.byteLength(section)} UTF-8 bytes including heading and guidance.\n`,
	);
});

it("resolves encoded service keys against the live roster and preserves the exact remote and command names", () => {
	const alias = { ...tool("drive__search_v2_a127fe26", "Drive / Research%"), mcpToolName: "search.v2" };
	const other = tool("other", "Other");
	const state = commands([alias, other]);
	const key = "drive%20%2F%20research%25";
	expect(catalog(state).section).toContain("help://services/" + key);
	const listing = serviceCommandDocs(state, key);
	expect(listing).toContain('"search.v2" → `drive__search_v2_a127fe26`');
	expect(listing).toContain(alias.description);
	expect(listing).not.toContain("`other`");
	state.mountedNames.delete(alias.name);
	expect(() => serviceCommandDocs(state, key)).toThrow("No mounted tools");
	expect(() => serviceCommandDocs(state, "%ff")).toThrow("Invalid service catalog URL");
});
