import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPLoadResult, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthServerCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { serverStatusLine } from "@oh-my-pi/pi-coding-agent/scient/mcp-command";
import { pickUpMcpSignIns } from "@oh-my-pi/pi-coding-agent/scient/mcp-sign-in-pickup";

const URL_A = "https://mcp.example.test/mcp";
const NAME = "tools@market:api";
const CHALLENGE =
	'HTTP 401: Unauthorized [WWW-Authenticate: Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"]';
const bound = (
	auth: MCPServerConfig["auth"] = { type: "oauth", credentialId: mcpOAuthServerCredentialId(NAME, URL_A) },
) => ({ type: "http", url: URL_A, auth }) as MCPServerConfig;
const token = (access: string) => ({ type: "oauth" as const, access, refresh: "r", expires: Date.now() + 3_600_000 });

/** The few manager members these helpers read; the rest of MCPManager is not involved. */
function fakeManager(
	servers: Record<string, { config: MCPServerConfig; source?: Partial<SourceMeta>; tools?: number }>,
) {
	const connected = new Set<string>();
	const reconnects: string[] = [];
	const manager = {
		getAllServerNames: () => Object.keys(servers),
		getConnectionStatus: (name: string) => (connected.has(name) ? "connected" : "disconnected"),
		getServerConfig: (name: string) => servers[name]?.config,
		getSource: (name: string) => servers[name]?.source,
		getConnection: (name: string) =>
			connected.has(name) || servers[name]?.tools
				? { tools: Array.from({ length: servers[name]?.tools ?? 0 }) }
				: undefined,
		reconnectServer: async (name: string) => {
			reconnects.push(name);
			connected.add(name);
			return null;
		},
		disconnect: (name: string) => connected.delete(name),
	};
	// Structural fake: only the members above are called by the code under test.
	return { manager: manager as unknown as MCPManager, reconnects, disconnect: manager.disconnect };
}

const loadResult = (connected: string[], errors: Record<string, string>): MCPLoadResult => ({
	tools: [],
	errors: new Map(Object.entries(errors)),
	connectedServers: connected,
	exaApiKeys: [],
});

describe("scient-agent mcp list", () => {
	it("reports a server refusing an anonymous call as needing sign-in, and whether a browser sign-in serves it", () => {
		const { manager } = fakeManager({
			[NAME]: { config: bound(), source: { level: "user", pluginName: "tools@market" } },
			"own-token": { config: bound({ type: "bearer" } as unknown as MCPServerConfig["auth"]) },
			header: { config: { type: "http", url: URL_A, headers: { Authorization: "Bearer x" } } },
			down: { config: bound() },
		});
		const loaded = loadResult([], {
			[NAME]: CHALLENGE,
			"own-token": CHALLENGE,
			header: CHALLENGE,
			down: "getaddrinfo ENOTFOUND",
		});
		expect(serverStatusLine(manager, NAME, loaded)).toEqual({
			name: NAME,
			status: "needs-auth",
			scope: "user",
			pluginId: "tools@market",
			error: CHALLENGE,
			canStartSignIn: true,
		});
		expect(serverStatusLine(manager, "own-token", loaded)).not.toHaveProperty("canStartSignIn");
		expect(serverStatusLine(manager, "header", loaded)).not.toHaveProperty("canStartSignIn");
		expect(serverStatusLine(manager, "down", loaded).status).toBe("failed");
	});

	it("reports a connected server's tool count and a server still starting as pending", () => {
		const { manager } = fakeManager({ ok: { config: bound(), tools: 3 }, slow: { config: bound() } });
		const loaded = loadResult(["ok"], {});
		expect(serverStatusLine(manager, "ok", loaded)).toMatchObject({ status: "connected", toolCount: 3 });
		expect(serverStatusLine(manager, "slow", loaded).status).toBe("pending");
	});
});

describe("a conversation picking up a sign-in made elsewhere", () => {
	const stores: AuthStorage[] = [];
	afterEach(() => {
		while (stores.length > 0) stores.pop()?.close();
	});
	const storage = () => {
		const store = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		stores.push(store);
		return store;
	};

	it("connects a server once its sign-in appears, and retries only when that sign-in changes", async () => {
		const auth = storage();
		const { manager, reconnects, disconnect } = fakeManager({ [NAME]: { config: bound() } });
		const tried = new Map<string, string>();
		let refreshed = 0;
		const pickUp = () => pickUpMcpSignIns(manager, auth, tried, async () => void refreshed++);

		await pickUp();
		expect(reconnects).toEqual([]);

		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("first"));
		await pickUp();
		expect(reconnects).toEqual([NAME]);
		expect(refreshed).toBe(1);

		// The server dropped again, e.g. its sign-in was refused: the same sign-in is not retried each prompt.
		disconnect(NAME);
		await pickUp();
		expect(reconnects).toEqual([NAME]);

		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("second"));
		await pickUp();
		expect(reconnects).toEqual([NAME, NAME]);
	});

	it("never reconnects a server a browser sign-in does not serve", async () => {
		const auth = storage();
		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("t"));
		const { manager, reconnects } = fakeManager({
			header: { config: { ...bound(), headers: { Authorization: "Bearer x" } } as MCPServerConfig },
			local: { config: { type: "stdio", command: "server" } as MCPServerConfig },
		});
		await pickUpMcpSignIns(manager, auth, new Map(), async () => {});
		expect(reconnects).toEqual([]);
	});
});
