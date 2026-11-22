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
 * A failure before any of that prints `{ "error": { "message" } }` and exits 1. Every message is
 * written here: a server's or authorization server's own text, which can echo a token, a code or a
 * secret, never reaches the output.
 */
import { getMCPConfigPath } from "@oh-my-pi/pi-utils";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { initializeWithSettings } from "../capability";
import type { SourceMeta } from "../capability/types";
import { Settings } from "../config/settings";
import { expandEnvVarsDeep } from "../discovery/helpers";
import { loadAllMCPConfigs } from "../mcp/config";
import { readMCPConfigFile } from "../mcp/config-writer";
import { type MCPLoadResult, MCPManager } from "../mcp/manager";
import { analyzeAuthError } from "../mcp/oauth-discovery";
import { MCPOAuthClientIdRequiredError } from "../mcp/oauth-flow";
import {
	type FoundMcpServer,
	MCPOAuthCancelledError,
	McpReauthRefusalError,
	reauthorizeMcpServer,
} from "../mcp/oauth-reauth";
import { cfgMcpEnableProjectConfig } from "../mcp/settings";
import type { MCPServerConfig } from "../mcp/types";
import type { AuthStorage } from "../session/auth-storage";
import { discoverAuthStorage } from "../sdk";
import { mcpHelp } from "./command-help";
import { boundSignInNeedsLocalSecret, canSignIn } from "./mcp-sign-in-pickup";

/** How long `list` waits for servers to answer, matching a conversation's startup window. */
const LIST_WAIT_MS = 15_000;

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

/** A connection failure in words written here: the HTTP status at most, never the server's text. */
function connectionFailure(config: MCPServerConfig | undefined, failure: string): string {
	const status = /^HTTP (\d{3})\b/.exec(failure)?.[1];
	if (status) return `The server answered HTTP ${status}.`;
	if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out/i.test(failure)) {
		return "The server could not be reached.";
	}
	if (config?.type === "stdio" || config?.type === undefined) return "The server's process did not start.";
	return "The server could not be connected.";
}

/** One server's status once the startup window closed, for `list`. */
export function serverStatusLine(
	manager: MCPManager,
	name: string,
	loaded: MCPLoadResult,
	authStorage?: AuthStorage,
): McpServerStatusLine {
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
	const url = config && (config.type === "http" || config.type === "sse") ? config.url : undefined;
	if (url && config && analyzeAuthError(new Error(failure), url).requiresAuth) {
		const signIn =
			canSignIn(config) &&
			addressIsPublic(url) &&
			!(authStorage && boundSignInNeedsLocalSecret(config, authStorage));
		return {
			...base,
			status: "needs-auth",
			error: "Sign-in needed.",
			...(signIn && { canStartSignIn: true as const }),
		};
	}
	return { ...base, status: "failed", error: connectionFailure(config, failure) };
}

/** A sign-in failure in words written here; the engine's own refusal text can quote a server's arguments. */
export function loginFailureMessage(name: string, bound: boolean, error: unknown): string {
	if (error instanceof McpReauthRefusalError) return `${name} cannot be signed in to with a browser from here.`;
	if (error instanceof MCPOAuthCancelledError) return "The sign-in was cancelled.";
	if (error instanceof MCPOAuthClientIdRequiredError) {
		return bound
			? `${name} lets only the apps it has approved sign in, and it does not accept Scient Agent yet.`
			: `${name} needs an OAuth client ID configured before Scient Agent can sign in.`;
	}
	const message = error instanceof Error ? error.message : "";
	if (message.startsWith("OAuth flow timed out")) return "The sign-in was not finished in time. Try again.";
	const status = /^Token exchange failed: (\d{3})\b/.exec(message)?.[1];
	if (status) return `${name}'s sign-in server refused the sign-in (HTTP ${status}). Try again.`;
	return `Signing in to ${name} did not complete. Try again.`;
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
		// Discovery honours the user's provider switches, as a conversation's does.
		const releaseSettings = initializeWithSettings(settings);
		const authStorage = await discoverAuthStorage(undefined, { settings });
		const manager = new MCPManager(cwd, null);
		manager.setAuthStorage(authStorage);
		const abort = new AbortController();
		const onSignal = (): void => abort.abort();
		process.once("SIGTERM", onSignal);
		process.once("SIGINT", onSignal);
		try {
			const only = args.action === "login" ? args.server : flags.server;
			if (args.action === "login" && !only) throw new McpReauthRefusalError("Name the server to sign in to.");
			const loaded = await loadAllMCPConfigs(cwd, { enableProjectConfig: cfgMcpEnableProjectConfig.get(settings) });
			const configs = only
				? Object.fromEntries(Object.entries(loaded.configs).filter(([name]) => name === only))
				: loaded.configs;
			if (args.action === "login")
				await this.#login(only!, configs, loaded.sources, manager, authStorage, abort, cwd);
			else await this.#list(configs, loaded.sources, manager, authStorage);
		} catch (error) {
			const message =
				error instanceof McpReauthRefusalError ? error.message : "Scient Agent could not read its MCP servers.";
			print({ error: { message } });
			process.exitCode = 1;
		} finally {
			process.off("SIGTERM", onSignal);
			process.off("SIGINT", onSignal);
			await manager.disconnectAll().catch(() => {});
			authStorage.close();
			releaseSettings();
		}
		// The startup window's timer outlives a startup that settled sooner; nothing else is left to do.
		process.exit();
	}

	async #list(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		manager: MCPManager,
		authStorage: AuthStorage,
	): Promise<void> {
		const loaded = await manager.connectServers(configs, sources, undefined, LIST_WAIT_MS);
		print({ servers: Object.keys(configs).map(name => serverStatusLine(manager, name, loaded, authStorage)) });
	}

	async #login(
		name: string,
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		manager: MCPManager,
		authStorage: AuthStorage,
		abort: AbortController,
		cwd: string,
	): Promise<void> {
		const config = configs[name];
		const source = sources[name];
		if (!config) throw new McpReauthRefusalError(`No MCP server named "${name}" is configured.`);
		// Cases a browser sign-in cannot serve, refused here in words written here, before any connection.
		if (config.enabled === false) throw new McpReauthRefusalError(`${name} is turned off.`);
		if (!canSignIn(config)) {
			throw new McpReauthRefusalError(
				`${name} does not sign in with a browser: it runs on this computer or uses its own key.`,
			);
		}
		if (boundSignInNeedsLocalSecret(config, authStorage)) {
			throw new McpReauthRefusalError(
				`${name} needs its client secret at every refresh, which the shared sign-in service cannot supply.`,
			);
		}
		// A key in the server's own address would reach a sign-in server as its resource, even from a refresh.
		if (!addressIsPublic(urlOf(config))) {
			throw new McpReauthRefusalError(
				`${name}'s address carries values of its own, which Scient Agent does not send to a sign-in page.`,
			);
		}
		// Registers the definition the way a conversation does, so the sign-in uses the one it selected.
		await manager.connectServers(configs, sources, undefined, LIST_WAIT_MS);
		const found = await selectedServer(name, config, source, manager, cwd);
		if (!found) {
			throw new McpReauthRefusalError(`"${name}" is configured somewhere Scient Agent cannot sign in to it from.`);
		}
		const bound = source?.provider === CODEX_PLUGINS_PROVIDER;
		let withheld = false;
		try {
			await reauthorizeMcpServer(name, found, {
				authStorage,
				signal: abort.signal,
				cwd,
				mcpManager: manager,
				silent: true,
				onAuth: info => {
					if (!authorizationUrlIsPublic(info.url)) {
						withheld = true;
						abort.abort();
						return;
					}
					print({ type: "authorization_url", url: info.url });
				},
				onProgress: () => {},
			});
			print({ type: "completed" });
		} catch (error) {
			const message = withheld
				? `${name}'s address carries values of its own, which Scient Agent does not send to a sign-in page.`
				: loginFailureMessage(name, bound, error);
			print({ type: "failed", message });
			process.exitCode = 1;
		}
	}
}

const CODEX_PLUGINS_PROVIDER = "codex-plugins";

/** Whether an address carries no user name, password or query, any of which could hold a key. */
function addressIsPublic(address: string | undefined): boolean {
	if (address === undefined) return true;
	try {
		const url = new URL(address);
		return !url.username && !url.password && !url.search;
	} catch {
		return false;
	}
}

/**
 * Whether a sign-in page may be shown: it carries no user name or password, and the resource it
 * names (the server's address, when discovery gave no other) no user name, password or query.
 * The page's own query is the sign-in server's (OAuth parameters, its own settings) and is kept.
 */
export function authorizationUrlIsPublic(authorizationUrl: string): boolean {
	try {
		const page = new URL(authorizationUrl);
		if (page.username || page.password) return false;
		return page.searchParams.getAll("resource").every(resource => addressIsPublic(resource));
	} catch {
		return false;
	}
}

const transportOf = (config: MCPServerConfig): string =>
	config.type ?? ("url" in config && typeof config.url === "string" ? "http" : "stdio");
const urlOf = (config: MCPServerConfig): string | undefined =>
	"url" in config && typeof config.url === "string" ? config.url : undefined;

/**
 * The definition discovery selected for `name`, as the sign-in needs it. An imported Codex plugin
 * server is answered from the manager, never a same-named config file entry that lost to it. An
 * ordinary server comes from the very file discovery read it from, so a sign-in writes back where
 * `/mcp reauth` would, and only when that entry, expanded, is the selected one (same transport and
 * URL); a definition no readable config file holds (a plugin's) signs in as a discovered server.
 */
export async function selectedServer(
	name: string,
	config: MCPServerConfig,
	source: SourceMeta | undefined,
	manager: MCPManager,
	cwd: string,
): Promise<FoundMcpServer | null> {
	const selected = manager.getServerConfig(name) ?? config;
	const discovered: FoundMcpServer = {
		filePath: getMCPConfigPath("user", cwd),
		scope: "user",
		config: selected,
		discovered: true,
	};
	if (source?.provider === CODEX_PLUGINS_PROVIDER) return discovered;
	if (!source) return null;
	const entry = await readMCPConfigFile(source.path).then(
		file => file.mcpServers?.[name],
		() => undefined,
	);
	if (!entry) return discovered;
	const expanded = expandEnvVarsDeep(entry);
	if (transportOf(expanded) !== transportOf(selected) || urlOf(expanded) !== urlOf(selected)) return null;
	// The raw entry keeps its placeholders for write-back; a URL-only entry (Cursor, Claude) takes
	// the transport discovery inferred, as the sign-in needs it.
	return {
		filePath: source.path,
		scope: source.level === "project" ? "project" : "user",
		config: (entry.type ? entry : { ...entry, type: transportOf(selected) }) as MCPServerConfig,
		discovered: false,
	};
}
