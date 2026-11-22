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
 * Connects the MCP servers a sign-in made elsewhere (the host's Sign in, `scient-agent mcp login`)
 * now serves. A session reads sign-ins once, so a server that needed one stays disconnected until
 * something reconnects it; this runs before a prompt.
 *
 * Only a disconnected server that signs in with a browser is considered, and only when its stored
 * sign-in differs from the one last tried here (`tried`, per session), so a server whose sign-in
 * was refused is not retried on every prompt. Never throws.
 */
export async function pickUpMcpSignIns(
	manager: MCPManager,
	authStorage: AuthStorage,
	tried: Map<string, string>,
	onConnected: () => Promise<void>,
): Promise<void> {
	const candidates = manager.getAllServerNames().flatMap(name => {
		if (manager.getConnectionStatus(name) !== "disconnected") return [];
		const config = manager.getServerConfig(name);
		return config && canSignIn(config) ? [{ name, config }] : [];
	});
	if (candidates.length === 0) return;
	try {
		await authStorage.credentials.revalidate();
	} catch (err) {
		logger.warn("Re-reading sign-ins for MCP servers failed", { err });
		return;
	}
	let connected = false;
	for (const { name, config } of candidates) {
		const lookup = lookupMcpOAuthCredential(authStorage, config);
		if (!lookup) continue;
		const signature = `${lookup.credentialId}\0${Bun.hash(lookup.credential.access ?? "")}`;
		if (tried.get(name) === signature) continue;
		tried.set(name, signature);
		try {
			await manager.reconnectServer(name, { manual: true });
			connected ||= manager.getConnectionStatus(name) === "connected";
		} catch (err) {
			logger.warn("Connecting an MCP server with its new sign-in failed", { server: name, err });
		}
	}
	if (connected) await onConnected();
}
