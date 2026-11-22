import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPLoadResult, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { mcpOAuthServerCredentialId } from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { McpReauthRefusalError, reauthorizeMcpServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	authorizationUrlIsPublic,
	loginFailureMessage,
	selectedServer,
	serverStatusLine,
} from "@oh-my-pi/pi-coding-agent/scient/mcp-command";
import { McpSignInPickup } from "@oh-my-pi/pi-coding-agent/scient/mcp-sign-in-pickup";

const URL_A = "https://mcp.example.test/mcp";
const NAME = "tools@market:api";
const LEAKED = "sk-live-SECRET";
const CHALLENGE = `HTTP 401: Unauthorized {"echo":"Bearer ${LEAKED}"} [WWW-Authenticate: Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"]`;
const bound = (
	auth: MCPServerConfig["auth"] = { type: "oauth", credentialId: mcpOAuthServerCredentialId(NAME, URL_A) },
	extra: Partial<MCPServerConfig> = {},
) => ({ type: "http", url: URL_A, auth, ...extra }) as MCPServerConfig;
const token = (access: string) => ({ type: "oauth" as const, access, refresh: "r", expires: Date.now() + 3_600_000 });

/** The few manager members these helpers read; the rest of MCPManager is not involved. */
function fakeManager(
	servers: Record<string, { config: MCPServerConfig; source?: Partial<SourceMeta>; tools?: number }>,
	reconnect: (name: string) => Promise<void> = async () => {},
) {
	const connected = new Set<string>();
	const reconnects: string[] = [];
	const manager = {
		getAllServerNames: () => Object.keys(servers),
		getConnectionStatus: (name: string) => (connected.has(name) ? "connected" : "disconnected"),
		getServerConfig: (name: string) => servers[name]?.config,
		getSource: (name: string) => servers[name]?.source,
		getConnection: (name: string) =>
			servers[name]?.tools ? { tools: Array.from({ length: servers[name]?.tools ?? 0 }) } : undefined,
		reconnectServer: async (name: string) => {
			reconnects.push(name);
			await reconnect(name);
			connected.add(name);
			return null;
		},
	};
	// Structural fake: only the members above are called by the code under test.
	return {
		manager: manager as unknown as MCPManager,
		reconnects,
		disconnect: (name: string) => connected.delete(name),
	};
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
		});
		const loaded = loadResult([], { [NAME]: CHALLENGE, "own-token": CHALLENGE, header: CHALLENGE });
		expect(serverStatusLine(manager, NAME, loaded)).toEqual({
			name: NAME,
			status: "needs-auth",
			scope: "user",
			pluginId: "tools@market",
			error: "Sign-in needed.",
			canStartSignIn: true,
		});
		expect(serverStatusLine(manager, "own-token", loaded)).not.toHaveProperty("canStartSignIn");
		expect(serverStatusLine(manager, "header", loaded)).not.toHaveProperty("canStartSignIn");
	});

	it("never prints what a server sent back, which can echo a token", () => {
		const { manager } = fakeManager({ [NAME]: { config: bound() }, down: { config: bound() } });
		const loaded = loadResult([], {
			[NAME]: CHALLENGE,
			down: `HTTP 500: Internal Server Error {"authorization":"Bearer ${LEAKED}"}`,
		});
		const lines = [serverStatusLine(manager, NAME, loaded), serverStatusLine(manager, "down", loaded)];
		expect(JSON.stringify(lines)).not.toContain(LEAKED);
		expect(lines[1]).toMatchObject({ status: "failed", error: "The server answered HTTP 500." });
	});

	it("reports a connected server's tool count and a server still starting as pending", () => {
		const { manager } = fakeManager({ ok: { config: bound(), tools: 3 }, slow: { config: bound() } });
		const loaded = loadResult(["ok"], {});
		expect(serverStatusLine(manager, "ok", loaded)).toMatchObject({ status: "connected", toolCount: 3 });
		expect(serverStatusLine(manager, "slow", loaded).status).toBe("pending");
	});
});

describe("scient-agent mcp login", () => {
	it("never prints what the sign-in server sent back", () => {
		const exchange = new Error(`Token exchange failed: 400 {"code":"${LEAKED}","client_secret":"${LEAKED}"}`);
		const message = loginFailureMessage(NAME, true, exchange);
		expect(message).not.toContain(LEAKED);
		expect(message).toContain("HTTP 400");
		expect(loginFailureMessage(NAME, true, new Error(`boom ${LEAKED}`))).not.toContain(LEAKED);
		// The engine's refusal for a local server quotes its expanded URL argument.
		const refusal = new McpReauthRefusalError(`use https://remote.example.test/mcp?token=${LEAKED} instead`);
		expect(loginFailureMessage(NAME, false, refusal)).not.toContain(LEAKED);
	});

	it("does not offer an imported sign-in a broker could not refresh", async () => {
		// A broker-held store: refresh happens without the server's definition, so without its secret.
		const authStorage = { credentials: { heldByBroker: true } } as unknown as AuthStorage;
		const config = bound(undefined, {
			oauth: { clientId: "id", clientSecret: "secret" },
		} as Partial<MCPServerConfig>);
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			await expect(
				reauthorizeMcpServer(NAME, { filePath: "", scope: "user", config, discovered: true }, { authStorage }),
			).rejects.toBeInstanceOf(McpReauthRefusalError);
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
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
		let refreshed = 0;
		const pickup = new McpSignInPickup(manager, auth, async () => void refreshed++);
		pickup.seed();

		await pickup.beforePrompt();
		expect(reconnects).toEqual([]);

		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("first"));
		await pickup.beforePrompt();
		expect(reconnects).toEqual([NAME]);
		expect(refreshed).toBe(1);

		// The server dropped again, e.g. its sign-in was refused: the same sign-in is not retried each prompt.
		disconnect(NAME);
		await pickup.beforePrompt();
		expect(reconnects).toEqual([NAME]);

		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("second"));
		await pickup.beforePrompt();
		expect(reconnects).toEqual([NAME, NAME]);
	});

	it("does not retry the sign-in the session started with", async () => {
		const auth = storage();
		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("startup"));
		const { manager, reconnects } = fakeManager({ [NAME]: { config: bound() } });
		const pickup = new McpSignInPickup(manager, auth, async () => {});
		pickup.seed();
		await pickup.beforePrompt();
		expect(reconnects).toEqual([]);
	});

	it("holds a prompt only briefly while a reconnect is slow, and finishes it in the background", async () => {
		const auth = storage();
		const gate = Promise.withResolvers<void>();
		const { manager, reconnects } = fakeManager({ [NAME]: { config: bound() } }, () => gate.promise);
		let refreshed = 0;
		const pickup = new McpSignInPickup(manager, auth, async () => void refreshed++);
		pickup.seed();
		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("new"));

		await pickup.beforePrompt(10);
		expect(reconnects).toEqual([NAME]);
		expect(refreshed).toBe(0);
		// A second prompt joins the running pickup instead of starting another.
		await pickup.beforePrompt(10);
		expect(reconnects).toEqual([NAME]);

		gate.resolve();
		await pickup.beforePrompt();
		expect(refreshed).toBe(1);
	});

	it("never reconnects a server a browser sign-in does not serve", async () => {
		const auth = storage();
		await auth.credentials.set(mcpOAuthServerCredentialId(NAME, URL_A), token("t"));
		const { manager, reconnects } = fakeManager({
			header: { config: bound(undefined, { headers: { Authorization: "Bearer x" } } as Partial<MCPServerConfig>) },
			local: { config: { type: "stdio", command: "server" } as MCPServerConfig },
		});
		await new McpSignInPickup(manager, auth, async () => {}).beforePrompt();
		expect(reconnects).toEqual([]);
	});
});

describe("which server mcp login signs in to", () => {
	it("never shows a sign-in page whose resource carries the server's own key", () => {
		const page = (resource: string) =>
			`https://auth.example.test/authorize?client_id=c&resource=${encodeURIComponent(resource)}`;
		expect(authorizationUrlIsPublic(page("https://mcp.example.test/mcp"))).toBe(true);
		expect(authorizationUrlIsPublic(page(`https://mcp.example.test/mcp?key=${LEAKED}`))).toBe(false);
		expect(authorizationUrlIsPublic(page(`https://user:${LEAKED}@mcp.example.test/mcp`))).toBe(false);
		expect(authorizationUrlIsPublic(`https://u:${LEAKED}@auth.example.test/authorize?client_id=c`)).toBe(false);
		// The sign-in server's own settings in its page address are its own and kept.
		expect(authorizationUrlIsPublic(`https://auth.example.test/authorize?tenant=t&client_id=c`)).toBe(true);
	});

	it("signs an ordinary server in from the file discovery read, only when that entry is the selected one", async () => {
		using temp = TempDir.createSync("@scient-mcp-login-select-");
		const file = path.join(temp.path(), ".mcp.json");
		await Bun.write(file, JSON.stringify({ mcpServers: { api: { type: "http", url: URL_A } } }));
		const source = { provider: "mcp-json", providerName: "", path: file, level: "project" } as SourceMeta;
		const selected = { type: "http", url: URL_A } as MCPServerConfig;
		const { manager } = fakeManager({ api: { config: selected } });
		expect(await selectedServer("api", selected, source, manager, temp.path())).toMatchObject({
			filePath: file,
			scope: "project",
			discovered: false,
		});
		// The file's entry now points elsewhere than the server discovery selected: no sign-in for it.
		const other = { type: "http", url: "https://elsewhere.example.test/mcp" } as MCPServerConfig;
		const { manager: otherManager } = fakeManager({ api: { config: other } });
		expect(await selectedServer("api", other, source, otherManager, temp.path())).toBeNull();
	});

	it("signs in to a URL-only entry (Cursor, Claude) over the transport discovery inferred", async () => {
		using temp = TempDir.createSync("@scient-mcp-login-urlonly-");
		const file = path.join(temp.path(), "mcp.json");
		await Bun.write(file, JSON.stringify({ mcpServers: { api: { url: URL_A } } }));
		const source = { provider: "cursor", providerName: "", path: file, level: "user" } as SourceMeta;
		const selected = { type: "http", url: URL_A } as MCPServerConfig;
		const { manager } = fakeManager({ api: { config: selected } });
		const found = await selectedServer("api", selected, source, manager, temp.path());
		expect(found?.config).toMatchObject({ type: "http", url: URL_A });
		expect(found?.filePath).toBe(file);
	});
});

it("a malformed sign-in id never stops a conversation from starting", () => {
	const auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
	try {
		const config = {
			type: "http",
			url: URL_A,
			auth: { type: "oauth", credentialId: 42 },
		} as unknown as MCPServerConfig;
		const { manager } = fakeManager({ broken: { config } });
		expect(() => new McpSignInPickup(manager, auth, async () => {}).seed()).not.toThrow();
	} finally {
		auth.close();
	}
});
