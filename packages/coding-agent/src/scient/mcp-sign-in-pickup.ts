import { logger } from "@oh-my-pi/pi-utils";
import type { MCPManager } from "../mcp/manager";
import { hasMcpAuthorizationHeader, lookupMcpOAuthCredential } from "../mcp/oauth-credentials";
import { isMcpOAuthServerCredentialId } from "../mcp/oauth-flow";
import type { MCPServerConfig, MCPServerConnection } from "../mcp/types";
import type { AuthStorage } from "../session/auth-storage";

/** Whether a browser sign-in can serve this server: http/sse, no token of its own. */
export function canSignIn(config: MCPServerConfig): boolean {
	if (config.type !== "http" && config.type !== "sse") return false;
	if (hasMcpAuthorizationHeader(config)) return false;
	// A config file can hold `auth: null`, which means no auth block, as the credential lookup reads it.
	const auth = config.auth ?? undefined;
	// A server bound to its own sign-in (an imported Codex plugin server) signs in only with OAuth.
	if (isMcpOAuthServerCredentialId(auth?.credentialId)) return auth?.type === "oauth";
	return auth === undefined || auth.type === "oauth";
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

/** A retained link uses the upstream no-store policy for the duration of its sign-in check. */
export async function withMcpCatalogPolicy<T>(
	connection: MCPServerConnection,
	live: boolean | undefined,
	read: () => Promise<T>,
): Promise<T> {
	if (!live) return read();
	const previous = connection.live;
	connection.live = true;
	try {
		return await read();
	} finally {
		connection.live = previous;
	}
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
 * A cached attachment can still be ready after the host saw a live auth failure. Include it when its stored
 * sign-in differs from the one it started with or last tried here, so a refused sign-in is not
 * retried every prompt. Each server reconnects on its own and its tools are published as soon as it
 * connects, so a stalled server holds up no other; a prompt waits for a pickup only briefly.
 */
export class McpSignInPickup {
	readonly #tried = new Map<string, string>();
	/** Reconnects under way, by server, each settling once its tools are published; later prompts join them. */
	readonly #connecting = new Map<string, Promise<void>>();
	#reread: Promise<boolean> | undefined;
	#lastReread = Number.NEGATIVE_INFINITY;
	#published: Promise<void> = Promise.resolve();

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

	/** Starts a pickup and waits for it at most a short while; reconnects go on in the background. Never throws. */
	async beforePrompt(budgetMs = PROMPT_BUDGET_MS): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, budgetMs);
		try {
			await Promise.race([this.#pickUp(), promise]);
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

	/** Re-reads the sign-in store once for concurrent pickups; a broker at most every few seconds. */
	#rereadSignIns(): Promise<boolean> {
		// A read under way is joined, so a later prompt waits for the sign-in it may bring.
		if (this.#reread) return this.#reread;
		if (this.authStorage.credentials.heldByBroker && performance.now() - this.#lastReread < BROKER_REREAD_MS) {
			return Promise.resolve(true);
		}
		this.#reread = (async () => {
			this.#lastReread = performance.now();
			try {
				await this.authStorage.credentials.revalidate();
				return true;
			} catch (err) {
				logger.warn("Re-reading sign-ins for MCP servers failed", { err });
				return false;
			} finally {
				this.#reread = undefined;
			}
		})();
		return this.#reread;
	}

	async #pickUp(): Promise<void> {
		const underWay = [...this.#connecting.values()];
		const candidates = this.manager.getAllServerNames().flatMap(name => {
			if (this.#connecting.has(name) || this.manager.getConnectionStatus(name) === "connecting") return [];
			const config = this.manager.getServerConfig(name);
			return config && canSignIn(config) ? [{ name, config }] : [];
		});
		const started =
			candidates.length > 0 && (await this.#rereadSignIns())
				? candidates.flatMap(({ name, config }) => {
						// Another prompt sharing this read may have started it: wait for that one.
						const existing = this.#connecting.get(name);
						if (existing) return [existing];
						if (
							this.manager.getServerConfig(name) !== config ||
							this.manager.getConnectionStatus(name) === "connecting"
						)
							return [];
						const signature = this.#signature(config);
						if (!signature || this.#tried.get(name) === signature) return [];
						this.#tried.set(name, signature);
						return [this.#reconnect(name)];
					})
				: [];
		await Promise.all([...underWay, ...started]);
	}

	/** Reconnects one server and publishes its tools once it connects. Never throws. */
	#reconnect(name: string): Promise<void> {
		const attempt = (async () => {
			try {
				const connection = await this.manager.reconnectServer(name, { live: true });
				if (!connection || this.manager.getConnectionStatus(name) !== "connected") return;
				this.#published = this.#published.then(() =>
					this.onConnected().catch(err => logger.warn("Refreshing tools after an MCP sign-in failed", { err })),
				);
				await this.#published;
			} catch (err) {
				logger.warn("Connecting an MCP server with its new sign-in failed", { server: name, err });
			} finally {
				this.#connecting.delete(name);
			}
		})();
		this.#connecting.set(name, attempt);
		return attempt;
	}
}
