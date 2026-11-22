/**
 * `scient-agent mcp`: the MCP servers a conversation would load, for a host that shows them and
 * signs in to them itself. Each subcommand prints JSON lines on stdout.
 *
 * - `list [--server <name>]` connects each server as a conversation would and prints
 *   `{ "servers": [{ "name", "status", "scope"?, "pluginId"?, "toolCount"?, "error"?, "canStartSignIn"? }] }`,
 *   status one of `connected`, `needs-auth`, `failed` or `pending`.
 * - `login <name>` runs the server's browser sign-in: it prints `{ "type": "authorization_url", "url" }`,
 *   keeps the local callback listener open, then prints `{ "type": "completed" }`, or
 *   `{ "type": "failed", "message" }` and exits 1. SIGTERM cancels it.
 *
 * A failure before any of that prints `{ "error": { "message" } }` and exits 1.
 */
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import type { SourceMeta } from "../capability/types";
import { Settings } from "../config/settings";
import { loadAllMCPConfigs } from "../mcp/config";
import { type MCPLoadResult, MCPManager } from "../mcp/manager";
import { analyzeAuthError } from "../mcp/oauth-discovery";
import { isMcpOAuthServerCredentialId, MCPOAuthClientIdRequiredError } from "../mcp/oauth-flow";
import {
	findMcpServerForAuth,
	MCPOAuthCancelledError,
	McpReauthRefusalError,
	reauthorizeMcpServer,
} from "../mcp/oauth-reauth";
import { cfgMcpEnableProjectConfig } from "../mcp/settings";
import type { MCPServerConfig } from "../mcp/types";
import type { AuthStorage } from "../session/auth-storage";
import { discoverAuthStorage } from "../sdk";
import { mcpHelp } from "./command-help";
import { canSignIn } from "./mcp-sign-in-pickup";

/** How long `list` waits for servers to answer, matching a conversation's startup window. */
const LIST_WAIT_MS = 15_000;
const MAX_ERROR_LENGTH = 500;

export interface McpServerStatusLine {
	name: string;
	status: "connected" | "needs-auth" | "failed" | "pending";
	scope?: "user" | "project";
	pluginId?: string;
	toolCount?: number;
	error?: string;
	canStartSignIn?: true;
}

function print(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** One server's status once the startup window closed, for `list`. */
export function serverStatusLine(manager: MCPManager, name: string, loaded: MCPLoadResult): McpServerStatusLine {
	const source = manager.getSource(name);
	const config = manager.getServerConfig(name);
	const base: McpServerStatusLine = {
		name,
		status: "pending",
		...(source && { scope: source.level === "project" ? "project" : "user" }),
		...(source?.pluginName && { pluginId: source.pluginName }),
	};
	if (loaded.connectedServers.includes(name)) {
		const toolCount = manager.getConnection(name)?.tools?.length ?? 0;
		return { ...base, status: "connected", ...(toolCount > 0 && { toolCount }) };
	}
	const failure = loaded.errors.get(name);
	if (failure === undefined) return base;
	const error = failure.slice(0, MAX_ERROR_LENGTH);
	const url = config && (config.type === "http" || config.type === "sse") ? config.url : undefined;
	if (url && config && analyzeAuthError(new Error(failure), url).requiresAuth) {
		return { ...base, status: "needs-auth", error, ...(canSignIn(config) && { canStartSignIn: true as const }) };
	}
	return { ...base, status: "failed", error };
}

/** A sign-in failure in words a person acts on. */
function loginFailureMessage(name: string, config: MCPServerConfig, error: unknown): string {
	if (error instanceof MCPOAuthCancelledError) return "The sign-in was cancelled.";
	if (error instanceof MCPOAuthClientIdRequiredError && isMcpOAuthServerCredentialId(config.auth?.credentialId)) {
		return `${name} lets only the apps it has approved sign in, and it does not accept Scient Agent yet.`;
	}
	return error instanceof Error ? error.message : String(error);
}

export default class Mcp extends Command {
	static description = mcpHelp.description;
	static args = {
		action: Args.string({ description: "list or login", required: true, options: ["list", "login"] }),
		server: Args.string({ description: "Server name (login)" }),
	};
	static flags = {
		server: Flags.string({ description: "List only this server" }),
	};
	static examples = ["scient-agent mcp list", "scient-agent mcp login 'figma@openai-curated:figma'"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Mcp);
		const cwd = process.cwd();
		const settings = await Settings.loadReadOnly();
		const authStorage = await discoverAuthStorage(undefined, { settings });
		const manager = new MCPManager(cwd, null);
		manager.setAuthStorage(authStorage);
		const abort = new AbortController();
		const onSignal = (): void => abort.abort();
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);
		try {
			const only = args.action === "login" ? args.server : flags.server;
			if (args.action === "login" && !only) throw new Error("Name the server to sign in to.");
			const loaded = await loadAllMCPConfigs(cwd, { enableProjectConfig: cfgMcpEnableProjectConfig.get(settings) });
			const configs = only
				? Object.fromEntries(Object.entries(loaded.configs).filter(([name]) => name === only))
				: loaded.configs;
			if (args.action === "login")
				await this.#login(only!, configs, loaded.sources, manager, authStorage, abort, cwd, settings);
			else await this.#list(configs, loaded.sources, manager);
		} catch (error) {
			print({ error: { message: error instanceof Error ? error.message : String(error) } });
			process.exitCode = 1;
		} finally {
			process.off("SIGTERM", onSignal);
			process.off("SIGINT", onSignal);
			await manager.disconnectAll().catch(() => {});
			authStorage.close();
		}
		// The startup window's timer outlives a startup that settled sooner; nothing else is left to do.
		process.exit();
	}

	async #list(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		manager: MCPManager,
	): Promise<void> {
		const loaded = await manager.connectServers(configs, sources, undefined, LIST_WAIT_MS);
		print({ servers: Object.keys(configs).map(name => serverStatusLine(manager, name, loaded)) });
	}

	async #login(
		name: string,
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		manager: MCPManager,
		authStorage: AuthStorage,
		abort: AbortController,
		cwd: string,
		settings: Settings,
	): Promise<void> {
		if (!configs[name]) throw new Error(`No MCP server named "${name}" is configured.`);
		// Registers the definition the way a conversation does, so the lookup finds discovered servers.
		await manager.connectServers(configs, sources, undefined, LIST_WAIT_MS);
		const found = await findMcpServerForAuth(name, cwd, manager, {
			enableProjectConfig: cfgMcpEnableProjectConfig.get(settings),
		});
		if (!found) throw new Error(`No MCP server named "${name}" is configured.`);
		try {
			await reauthorizeMcpServer(name, found, {
				authStorage,
				signal: abort.signal,
				cwd,
				mcpManager: manager,
				silent: true,
				onAuth: info => print({ type: "authorization_url", url: info.url }),
				onProgress: () => {},
			});
			print({ type: "completed" });
		} catch (error) {
			const message =
				error instanceof McpReauthRefusalError ? error.message : loginFailureMessage(name, found.config, error);
			print({ type: "failed", message });
			process.exitCode = 1;
		}
	}
}
