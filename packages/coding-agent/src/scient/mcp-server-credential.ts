import { getActiveProfile } from "@oh-my-pi/pi-utils/dirs";
import type { SourceMeta } from "../capability/types";
import type { MCPAuthConfig, MCPServerConfig, MCPServerConnection } from "../mcp/types";

/** Credential-id prefix for one server's own sign-in (`mcp_oauth:server:<profile>:<encoded name>:<serverUrl>`). */
const MCP_OAUTH_SERVER_CREDENTIAL_PREFIX = "mcp_oauth:server:";

/**
 * Credential id for one server's own sign-in, under its profile. Lookups find it only through the
 * server's `auth.credentialId`, never by URL, so no other server at that URL shares it.
 */
export function mcpOAuthServerCredentialId(
	serverName: string,
	serverUrl: string,
	profile: string | undefined = getActiveProfile(),
): string {
	return `${MCP_OAUTH_SERVER_CREDENTIAL_PREFIX}${profile ?? "default"}:${encodeURIComponent(serverName)}:${serverUrl}`;
}

/** Whether a credential id is one server's own sign-in ({@link mcpOAuthServerCredentialId}). */
export function isMcpOAuthServerCredentialId(credentialId: unknown): boolean {
	return typeof credentialId === "string" && credentialId.startsWith(MCP_OAUTH_SERVER_CREDENTIAL_PREFIX);
}

/**
 * The auth block a server definition may use. A server-bound credential id stays only on the
 * server the codex-plugins source imported under it (the id its name and URL give); any other
 * definition drops it and finds its sign-in as a native server does.
 */
export function trustedMcpAuth(
	name: string,
	auth: MCPAuthConfig | undefined,
	url: string | undefined,
	provider: string | undefined,
): MCPAuthConfig | undefined {
	if (!auth || !isMcpOAuthServerCredentialId(auth.credentialId)) return auth;
	if (
		provider === "codex-plugins" &&
		url !== undefined &&
		auth.credentialId === mcpOAuthServerCredentialId(name, url)
	) {
		return auth;
	}
	return { ...auth, credentialId: undefined };
}

/** {@link trustedMcpAuth} applied to a server definition from the source `provider`. */
export function withTrustedMcpAuth(
	name: string,
	config: MCPServerConfig,
	provider: string | undefined,
): MCPServerConfig {
	const url = config.type === "http" || config.type === "sse" ? config.url : undefined;
	const auth = trustedMcpAuth(name, config.auth, url, provider);
	return auth === config.auth ? config : { ...config, auth };
}

/** An update may keep a plugin's provenance only when it retains the definition discovery selected. */
export function sourceForMcpUpdate(
	previous: MCPServerConfig | undefined,
	updated: MCPServerConfig,
	source: SourceMeta | undefined,
): SourceMeta | undefined {
	return source?.provider === "codex-plugins" && updated !== previous ? undefined : source;
}

/** Record the source together with its accepted definition, including a replacement with no source. */
export function setMcpDefinitionSource(
	sources: Map<string, SourceMeta>,
	name: string,
	source: SourceMeta | undefined,
	connection?: MCPServerConnection,
): void {
	if (source) sources.set(name, source);
	else sources.delete(name);
	if (connection) connection._source = source;
}

/** A host link may finish a refresh after an update. Only the selected definition may start or use it. */
export function refreshForMcpDefinition(
	isSelected: () => boolean,
	refresh: (() => Promise<Record<string, string> | null>) | undefined,
): (() => Promise<Record<string, string> | null>) | undefined {
	if (!refresh) return undefined;
	return async () => {
		if (!isSelected()) return null;
		const headers = await refresh();
		return isSelected() ? headers : null;
	};
}

/** The profile precedes the encoded name, which cannot contain a literal colon. */
export function serverCredentialProfile(credentialId: string): string | undefined {
	const profileEnd = credentialId.indexOf(":", MCP_OAUTH_SERVER_CREDENTIAL_PREFIX.length);
	return profileEnd === -1 ? undefined : credentialId.slice(MCP_OAUTH_SERVER_CREDENTIAL_PREFIX.length, profileEnd);
}

/** The remaining suffix is the verbatim URL, including its scheme, port and query. */
export function serverCredentialUrl(credentialId: string): string | undefined {
	const profileEnd = credentialId.indexOf(":", MCP_OAUTH_SERVER_CREDENTIAL_PREFIX.length);
	const nameEnd = profileEnd === -1 ? -1 : credentialId.indexOf(":", profileEnd + 1);
	return nameEnd === -1 ? undefined : credentialId.slice(nameEnd + 1) || undefined;
}

/**
 * Whether a server's own sign-in id belongs to this server URL under the active profile: a
 * definition naming another server's id, or one moved to another URL, gets nothing from it.
 */
export function mcpOAuthServerCredentialIdMatchesUrl(credentialId: string, serverUrl: string | undefined): boolean {
	return (
		serverUrl !== undefined &&
		isMcpOAuthServerCredentialId(credentialId) &&
		serverCredentialProfile(credentialId) === (getActiveProfile() ?? "default") &&
		serverCredentialUrl(credentialId) === serverUrl
	);
}
