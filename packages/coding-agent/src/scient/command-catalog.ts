import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { ToolCommandPromptDocs, ToolCommandState } from "../tools/tool-commands";
import { prompt } from "@oh-my-pi/pi-utils";
import catalogTemplate from "./command-catalog.md" with { type: "text" };
import serviceRow from "./command-service-row.md" with { type: "text" };

interface ServiceTool {
	readonly name: string;
	readonly description?: string;
	readonly summary?: string;
	readonly mcpServerName?: unknown;
	/** One line about the service, set by the registering extension; tool proxies carry it through. Opts the service into one catalog row. */
	readonly mcpServerDescription?: unknown;
	readonly mcpToolName?: unknown;
}

/** A service row lists its tool names, as Claude Code does, while they fit; larger ones point to their listing. */
const SERVICE_NAMES_ROW_BYTES = 4_000;
const SERVICE_NAMES_TOTAL_BYTES = 8_000;

/**
 * Stable service identity; display names and exact execution paths remain intact. Only a service
 * whose extension describes it is grouped: MCP servers configured in the agent itself keep
 * upstream's per-tool catalog lines and route block.
 */
function serviceKey(tool: ServiceTool): string | undefined {
	if (typeof tool.mcpServerName !== "string" || !tool.mcpServerName.trim()) return undefined;
	if (typeof tool.mcpServerDescription !== "string" || !tool.mcpServerDescription.trim()) return undefined;
	return tool.mcpServerName.trim().toLowerCase();
}

function oneLine(text: string): string {
	return truncateHeadBytes(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim(), 200).text;
}

function serviceDescription(tools: readonly ServiceTool[]): string {
	return oneLine(String(tools[0]!.mcpServerDescription)).replace(/[.\s]+$/, "");
}

function toolCount(count: number): string {
	return `${count} ${count === 1 ? "tool" : "tools"}`;
}

function servicePath(key: string): string {
	return `services/${encodeURIComponent(key)}`;
}

/** Inline entries keep their help and remote routes. Only catalog entries may share a row. */
function* groupedServiceTools(state: ToolCommandState | undefined, getDocs: () => ToolCommandPromptDocs | undefined) {
	if (!state?.isActive("read")) return;
	let plannedDocs: ToolCommandPromptDocs | undefined;
	for (const name of state.mountedNames) {
		const tool = state.tools.get(name);
		const key = tool && serviceKey(tool);
		if (!tool || !key) continue;
		plannedDocs ??= getDocs();
		if (plannedDocs?.catalog.has(name)) yield { key, tool };
	}
}

export function projectCommandServices(
	state: ToolCommandState | undefined,
	getDocs: () => ToolCommandPromptDocs | undefined,
) {
	const names = new Set<string>();
	const groups = new Map<string, ServiceTool[]>();
	for (const { key, tool } of groupedServiceTools(state, getDocs)) {
		const group = groups.get(key) ?? [];
		group.push(tool);
		groups.set(key, group);
		names.add(tool.name);
	}
	let namesBudget = SERVICE_NAMES_TOTAL_BYTES;
	const rows: string[] = [];
	for (const [key, tools] of groups) {
		const joined = tools.map(tool => tool.name).join(", ");
		const bytes = Buffer.byteLength(joined, "utf-8");
		const listNames = bytes <= SERVICE_NAMES_ROW_BYTES && bytes <= namesBudget;
		if (listNames) namesBudget -= bytes;
		rows.push(
			prompt
				.render(serviceRow, {
					service: oneLine(String(tools[0]!.mcpServerName)),
					description: serviceDescription(tools),
					count: toolCount(tools.length),
					names: listNames ? joined : undefined,
					path: servicePath(key),
				})
				.trim(),
		);
	}
	const section = rows.length
		? ["## Service commands", "", ...rows, "", "Run `<command> --help` in bash before first use."].join("\n")
		: "";
	return {
		names,
		section,
		remaining: <T extends ServiceTool>(tools: T[]) => tools.filter(tool => !names.has(tool.name)),
	};
}

/** A service row covers its grouped commands and their wire aliases in the eval description. */
export function evalPromptToolNames(
	names: string[],
	state: ToolCommandState | undefined,
	getDocs: () => ToolCommandPromptDocs | undefined,
): string[] {
	if (!state?.mountedNames.size) return names;
	const hidden = new Set<string>();
	for (const { tool } of groupedServiceTools(state, getDocs)) {
		hidden.add(tool.name);
		const alias = tool.customWireName;
		// An exact registry name wins over another tool's wire spelling. Ambiguous aliases
		// already have no entry in the eval bridge's callable-name snapshot.
		if (alias && !state.tools.has(alias)) hidden.add(alias);
	}
	return names.filter(name => !hidden.has(name));
}

/** Read the live roster so unmounts and command aliases take effect on the next read. */
export function serviceCommandDocs(state: ToolCommandState | undefined, topic: string): string {
	let key: string;
	try {
		key = decodeURIComponent(topic);
	} catch {
		throw new Error("Invalid service catalog URL.");
	}
	const tools: ServiceTool[] = [];
	if (state) {
		for (const name of state.mountedNames) {
			const tool = state.tools.get(name);
			if (tool && serviceKey(tool) === key) tools.push(tool);
		}
	}
	if (!tools.length) throw new Error("No mounted tools for this service. Check the session's command catalog.");
	return prompt.render(catalogTemplate, {
		service: oneLine(String(tools[0]!.mcpServerName)),
		description: serviceDescription(tools),
		tools: tools.map(tool => ({
			remote: JSON.stringify(typeof tool.mcpToolName === "string" ? tool.mcpToolName : tool.name)
				.replaceAll("`", "\\u0060")
				.replaceAll("\u2028", "\\u2028")
				.replaceAll("\u2029", "\\u2029"),
			name: tool.name,
			summary: oneLine(tool.summary || tool.description || tool.name),
		})),
	});
}
