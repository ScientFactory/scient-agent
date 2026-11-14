/**
 * A host that wants Scient Agent to use the person's ChatGPT apps sets SCIENT_AGENT_CHATGPT_APPS
 * to a comma-separated list: `all` for every app the ChatGPT sign-in has connected, an app id to
 * name one, and `-<id>` to leave one out (an app the host already reaches another way). At
 * session start the agent lists the connected apps and registers the chosen ones' tools as
 * discoverable tools; an app the account has not connected is skipped. Without the variable,
 * nothing changes.
 */
import { createHash } from "node:crypto";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { ExtensionFactory } from "../extensibility/extensions";
import { type ChatGptApp, ChatGptAppsClient, type ChatGptToolResult, chatGptAppConnectUrl } from "./chatgpt-apps";

export interface ChatGptAppsPolicy {
	readonly all: boolean;
	readonly include: readonly string[];
	readonly exclude: readonly string[];
}

const APP_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The apps the host asked for, or undefined when it asked for none. */
export function requestedChatGptApps(env: NodeJS.ProcessEnv = process.env): ChatGptAppsPolicy | undefined {
	const include = new Set<string>();
	const exclude = new Set<string>();
	let all = false;
	for (const raw of (env.SCIENT_AGENT_CHATGPT_APPS ?? "").split(",")) {
		const token = raw.trim();
		if (token === "all") all = true;
		else if (token.startsWith("-") && APP_ID.test(token.slice(1))) exclude.add(token.slice(1));
		else if (APP_ID.test(token)) include.add(token);
	}
	if (!all && include.size === 0) return undefined;
	return { all, include: [...include].sort(), exclude: [...exclude].sort() };
}

export function chosenByPolicy(policy: ChatGptAppsPolicy, id: string): boolean {
	return !policy.exclude.includes(id) && (policy.all || policy.include.includes(id));
}

/** The tool's model-facing name: `gmail.search_emails` becomes `gmail__search_emails`. */
export function chatGptToolName(app: ChatGptApp, remoteName: string): string {
	const dot = remoteName.indexOf(".");
	const prefix = dot > 0 ? remoteName.slice(0, dot) : app.name;
	const rest = dot > 0 ? remoteName.slice(dot + 1) : remoteName;
	const clean = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
	let name = `${clean(prefix).toLowerCase()}__${clean(rest)}`;
	if (!/^[A-Za-z_]/.test(name)) name = `_${name}`;
	if (name.length <= 64) return name;
	const digest = createHash("sha256").update(`${app.id}\0${remoteName}`).digest("hex").slice(0, 8);
	return `${name.slice(0, 55)}_${digest}`;
}

/** Codex marks a call an app could not make because its link to the service needs signing in again. */
function needsReconnect(result: ChatGptToolResult): boolean {
	const meta = result._meta as Record<string, unknown> | undefined;
	const failure = meta?.connector_auth_failure as Record<string, unknown> | undefined;
	return failure?.is_auth_failure === true;
}

function modelContent(app: ChatGptApp, result: ChatGptToolResult) {
	if (needsReconnect(result))
		throw new Error(
			`${app.name} needs to be connected again in ChatGPT. The person can reconnect it at ${chatGptAppConnectUrl(app)}.`,
		);
	const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
	for (const part of result.content) {
		if (part.type === "text" && typeof part.text === "string") content.push({ type: "text", text: part.text });
		else if (part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string")
			content.push({ type: "image", data: part.data, mimeType: part.mimeType });
		else content.push({ type: "text", text: JSON.stringify(part) });
	}
	// ChatGPT's apps put their data in structured content and only a summary in the text, so the
	// model gets both, unless a text part already repeats the structured payload.
	const structured = result.structuredContent;
	if (structured !== undefined && structured !== null && !repeatsInText(structured, content))
		content.push({ type: "text", text: JSON.stringify(structured) });
	return content;
}

function repeatsInText(structured: unknown, content: ReadonlyArray<{ type: string; text?: string }>): boolean {
	return content.some(part => {
		if (part.type !== "text" || !part.text?.trim()) return false;
		try {
			return Bun.deepEquals(JSON.parse(part.text), structured);
		} catch {
			return false;
		}
	});
}

function toolOutput(app: ChatGptApp, result: ChatGptToolResult) {
	const content = modelContent(app, result);
	if (result.isError === true) {
		const message = content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
		throw new Error(`${app.name} reported an error${message ? `: ${message}` : "."}`);
	}
	// Code that calls the tool (eval) reads the structured data without parsing the text.
	return {
		content,
		details: result.structuredContent === undefined ? undefined : { structuredContent: result.structuredContent },
	};
}

/**
 * One listing per credential store and app set, shared by a session and its subagents. Another
 * store (another host's sessions in the same process) gets its own client and account.
 */
const listingsByStore = new WeakMap<
	AuthStorage,
	Map<string, Promise<{ client: ChatGptAppsClient; apps: ChatGptApp[] }>>
>();

function listing(storage: AuthStorage, policy: ChatGptAppsPolicy) {
	const listings = listingsByStore.get(storage) ?? new Map();
	listingsByStore.set(storage, listings);
	const key = JSON.stringify(policy);
	let pending = listings.get(key);
	if (!pending) {
		const client = new ChatGptAppsClient(storage);
		pending = client.listApps(AbortSignal.timeout(30_000)).then(
			all => ({ client, apps: all.filter(app => chosenByPolicy(policy, app.id)) }),
			error => {
				// The next session may try again; this one goes on without the apps.
				listings.delete(key);
				throw error;
			},
		);
		listings.set(key, pending);
	}
	return pending;
}

export function createChatGptAppsExtension(storage: AuthStorage, policy: ChatGptAppsPolicy): ExtensionFactory {
	return async pi => {
		let found: { client: ChatGptAppsClient; apps: ChatGptApp[] };
		try {
			found = await listing(storage, policy);
		} catch (error) {
			logger.warn("ChatGPT apps unavailable", { error: error instanceof Error ? error.message : String(error) });
			return;
		}
		const { client, apps } = found;
		const taken = new Set<string>();
		for (const app of apps) {
			for (const tool of app.tools) {
				const name = chatGptToolName(app, tool.name);
				if (taken.has(name)) continue;
				taken.add(name);
				pi.registerTool({
					name,
					label: name,
					description: `${app.name}, through the person's ChatGPT account: ${tool.description}`,
					parameters: tool.inputSchema as never,
					// Like an MCP tool: changes stay conservative, the read-only hint only informs.
					approval: "write",
					mcpServerName: app.name,
					mcpToolName: tool.name,
					mcpReadOnlyHint: tool.readOnly,
					strict: false,
					async execute(_id, args, signal) {
						return toolOutput(app, await client.callTool(tool.name, args, signal));
					},
				});
			}
		}
	};
}
