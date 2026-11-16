import { truncateHeadBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import type { Tool, ToolSession } from "../tools";
import type { XdevPromptDocs, XdevState } from "../tools/xdev";
import { prompt } from "@oh-my-pi/pi-utils";
import catalogTemplate from "./xdev-catalog.md" with { type: "text" };
import serviceRow from "./xdev-service-row.md" with { type: "text" };

interface ServiceTool {
	readonly name: string;
	readonly description?: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

/** Stable service identity; display names and exact execution paths remain intact. */
function serviceKey(tool: ServiceTool): string | undefined {
	if (typeof tool.mcpServerName !== "string" || !tool.mcpServerName.trim()) return undefined;
	return tool.mcpServerName.trim().toLowerCase();
}

function oneLine(text: string): string {
	return truncateHeadBytes(text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim(), 200).text;
}

function servicePath(key: string): string {
	return `services/${encodeURIComponent(key)}`;
}

/** Group only catalog entries: an explicitly inlined tool keeps its full docs. */
export function groupXdevCatalog(state: XdevState, docs: XdevPromptDocs): XdevPromptDocs {
	const groups = new Map<string, { label: string; names: string[] }>();
	for (const name of docs.catalog.keys()) {
		const tool = state.tools.get(name) as ServiceTool | undefined;
		if (!tool) continue;
		const key = serviceKey(tool);
		if (!key) continue;
		const group = groups.get(key) ?? { label: oneLine(String(tool.mcpServerName)), names: [] };
		group.names.push(name);
		groups.set(key, group);
	}
	const catalog = new Map(docs.catalog);
	for (const [key, group] of groups) {
		for (const name of group.names) catalog.delete(name);
		catalog.set(
			servicePath(key),
			prompt.render(serviceRow, { service: group.label, count: group.names.length, path: servicePath(key) }).trim(),
		);
	}
	return { sections: docs.sections, catalog };
}

/** The grouped catalog owns MCP route discovery, including exact remote names. */
export function hasServiceCatalog(tool: ServiceTool): boolean {
	return serviceKey(tool) !== undefined;
}

/** Mounted tools are discoverable in xd catalogs; do not repeat their names in eval. */
export function evalPromptToolNames(session: ToolSession): readonly string[] | undefined {
	return session.getAdvertisedEvalToolNames?.().filter(name => !session.xdev?.mountedNames.has(name));
}

/** Read-only service listing. No service URL is ever executable. */
export function xdevServiceDocs(state: XdevState, topic: string): string {
	let key: string;
	try {
		key = decodeURIComponent(topic);
	} catch {
		throw new Error("Invalid service catalog URL.");
	}
	const tools = [...state.mountedNames]
		.map(name => state.tools.get(name) as (Tool & ServiceTool) | undefined)
		.filter((tool): tool is Tool & ServiceTool => tool !== undefined && serviceKey(tool) === key);
	if (!tools.length) throw new Error("No mounted tools for this service. Read xd:// for the current catalog.");
	return prompt.render(catalogTemplate, {
		service: oneLine(String(tools[0]!.mcpServerName)),
		tools: tools.map(tool => ({
			name: tool.name,
			remote: oneLine(typeof tool.mcpToolName === "string" ? tool.mcpToolName : tool.name),
			summary: oneLine(tool.description ?? ""),
		})),
	});
}
