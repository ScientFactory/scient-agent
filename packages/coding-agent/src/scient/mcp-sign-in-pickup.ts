import { logger } from "@oh-my-pi/pi-utils";
import type { MCPManager } from "../mcp/manager";
import { hasMcpAuthorizationHeader, lookupMcpOAuthCredential } from "../mcp/oauth-credentials";
import { isMcpOAuthServerCredentialId } from "../mcp/oauth-flow";
import type { MCPServerConfig } from "../mcp/types";
import type { AuthStorage } from "../session/auth-storage";

/** Whether a browser sign-in can serve this server: http/sse, no token of its own. */
export function canSignIn(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	if (hasMcpAuthorizationHeader(config)) return false;
	// A server bound to its own sign-in (an imported Codex plugin server) signs in only with OAuth.
	if (isMcpOAuthServerCredentialId(config.auth?.credentialId)) return config.auth?.type === "oauth";
	return config.auth === undefined || config.auth.type === "oauth";
}

/**
 * Whether an imported server's sign-in would need a client secret at every refresh that the
 * sign-in store cannot give: a bound sign-in keeps no secret, and a broker refreshes without the
 * server's definition, so such a sign-in could not be refreshed and is not offered.
 */
export function boundSignInNeedsLocalSecret(config: MCPServerConfig, authStorage: AuthStorage): boolean {
	return (
		isMcpOAuthServerCredentialId(config.auth?.credentialId) &&
		typeof config.oauth?.clientSecret === "string" &&
		authStorage.credentials.heldByBroker
	);
}

/** How long a prompt waits for a pickup; the rest finishes in the background. */
const PROMPT_BUDGET_MS = 1_500;
/** A broker's sign-ins are re-read at most this often, since each read is a request to it. */
const BROKER_REREAD_MS = 10_000;

/**
 * Connects the MCP servers a sign-in made elsewhere (the host's Sign in, `scient-agent mcp login`)
 * now serves. A session reads sign-ins once, so a server that needed one stays disconnected until
 * something reconnects it; a host calls {@link beforePrompt} before each prompt.
 *
 * Only a disconnected server that signs in with a browser is considered, and only when its stored
 * sign-in differs from the one it started with or last tried here, so a refused sign-in is not
 * retried every prompt. One pickup runs at a time, and a prompt waits for it only briefly.
 */
export class McpSignInPickup {
	readonly #tried = new Map<string, string>();
	#running: Promise<void> | undefined;
	#lastReread = Number.NEGATIVE_INFINITY;

	constructor(
		private readonly manager: MCPManager,
		private readonly authStorage: AuthStorage,
		private readonly onConnected: () => Promise<void>,
	) {}

	/** Records the sign-ins the session started with: its own startup already connected with them. */
	seed(): void {
		for (const name of this.manager.getAllServerNames()) {
			const config = this.manager.getServerConfig(name);
			const signature = config && canSignIn(config) ? this.#signature(config) : undefined;
			if (signature) this.#tried.set(name, signature);
		}
	}

	/** Starts a pickup unless one runs, and waits for it at most a short while. Never throws. */
	async beforePrompt(budgetMs = PROMPT_BUDGET_MS): Promise<void> {
		this.#running ??= this.#pickUp().finally(() => {
			this.#running = undefined;
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, budgetMs);
		try {
			await Promise.race([this.#running, promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** The stored sign-in a server would use; a malformed definition counts as none, never as a failure. */
	#signature(config: MCPServerConfig): string | undefined {
		try {
			const lookup = lookupMcpOAuthCredential(this.authStorage, config);
			return lookup ? `${lookup.credentialId}\0${Bun.hash(lookup.credential.access ?? "")}` : undefined;
		} catch {
			return undefined;
		}
	}

	async #pickUp(): Promise<void> {
		const candidates = this.manager.getAllServerNames().flatMap(name => {
			if (this.manager.getConnectionStatus(name) !== "disconnected") return [];
			const config = this.manager.getServerConfig(name);
			return config && canSignIn(config) ? [{ name, config }] : [];
		});
		if (candidates.length === 0) return;
		const broker = this.authStorage.credentials.heldByBroker;
		if (!broker || performance.now() - this.#lastReread >= BROKER_REREAD_MS) {
			this.#lastReread = performance.now();
			try {
				await this.authStorage.credentials.revalidate();
			} catch (err) {
				logger.warn("Re-reading sign-ins for MCP servers failed", { err });
				return;
			}
		}
		let connected = false;
		for (const { name, config } of candidates) {
			const signature = this.#signature(config);
			if (!signature || this.#tried.get(name) === signature) continue;
			this.#tried.set(name, signature);
			try {
				await this.manager.reconnectServer(name, { manual: true });
				connected ||= this.manager.getConnectionStatus(name) === "connected";
			} catch (err) {
				logger.warn("Connecting an MCP server with its new sign-in failed", { server: name, err });
			}
		}
		if (connected) {
			try {
				await this.onConnected();
			} catch (err) {
				logger.warn("Refreshing tools after an MCP sign-in failed", { err });
			}
		}
	}
}
