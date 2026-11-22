import { Database } from "bun:sqlite";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { initializeWithSettings } from "@oh-my-pi/pi-coding-agent/capability";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { loadAllMCPConfigs } from "@oh-my-pi/pi-coding-agent/mcp/config";
import { readDisabledServers } from "@oh-my-pi/pi-coding-agent/mcp/config-writer";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import {
	lookupMcpOAuthCredential,
	lookupMcpOAuthCredentialForServer,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import {
	McpReauthRefusalError,
	reauthorizeMcpServer,
	reconnectMcpManagerServer,
} from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { MCPCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { getAgentDir, getMCPConfigPath, getProjectDir, setAgentDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext, createMcpManagerStub } from "../helpers/interactive-mode-context";
import { restoreEnvValue } from "../helpers/settings-test-state";

const SERVER_URL = "https://mcp.example.test/mcp";
const NAME = "tools@market:api";
const placeholder = "$" + "{CODEX_PLUGIN_OAUTH_TEST}";
const token = { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
const boundConfig = (): MCPServerConfig => ({
	type: "http",
	url: SERVER_URL,
	headerPolicy: "origin-locked",
	auth: { type: "oauth", credentialId: oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL) },
});

beforeAll(() => initTheme());

describe("an imported Codex plugin server's own sign-in", () => {
	const stores: AuthStorage[] = [];
	const freshStorage = () => {
		const storage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		stores.push(storage);
		return storage;
	};
	const saved = process.env.CODEX_PLUGIN_OAUTH_TEST;

	afterEach(() => {
		while (stores.length > 0) stores.pop()?.close();
		vi.restoreAllMocks();
		restoreEnvValue("CODEX_PLUGIN_OAUTH_TEST", saved);
	});

	it("never takes another server's sign-in at the same URL", async () => {
		const storage = freshStorage();
		const token = { type: "oauth" as const, access: "a", refresh: "r", expires: Date.now() + 60_000 };
		await storage.credentials.set(oauthFlow.mcpOAuthCredentialId(SERVER_URL), { ...token, access: "write-scope" });
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		const auth = { type: "oauth" as const, credentialId };
		expect(lookupMcpOAuthCredentialForServer(storage, auth, SERVER_URL)).toBeUndefined();
		await storage.credentials.set(credentialId, { ...token, access: "own" });
		expect(lookupMcpOAuthCredentialForServer(storage, auth, SERVER_URL)?.credential.access).toBe("own");
		expect(oauthFlow.mcpOAuthServerUrlFromCredentialId(credentialId)).toBe(SERVER_URL);
	});

	it("signs in with the plugin's literal values, configured scope and resource, under its own id", async () => {
		// A value an `.env` file could supply; Codex never resolves a plugin header from it.
		restoreEnvValue("CODEX_PLUGIN_OAUTH_TEST", "dotenv-secret");
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		const config: MCPServerConfig = {
			type: "http",
			url: SERVER_URL,
			headers: { "X-Team": placeholder },
			headerPolicy: "origin-locked",
			auth: { type: "oauth", credentialId, resource: "https://resource.example.test/" },
			// The plugin asks for no scopes.
			oauth: { scope: "" },
		};
		const probed: MCPServerConfig[] = [];
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((async (_name: string, probe: MCPServerConfig) => {
			probed.push(probe);
			throw new Error(
				'HTTP 401: {"authorization_url":"https://auth.example.test/authorize?scope=admin","token_url":"https://auth.example.test/token","resource":"https://discovered.example.test/","scopes":"admin"}',
			);
		}) as never);
		const flows: { scopes?: string }[] = [];
		vi.spyOn(oauthFlow.MCPOAuthFlow.prototype, "login").mockImplementation(
			async function (this: { config: { scopes?: string } }) {
				flows.push(this.config);
				return { access: "fresh", refresh: "fresh-refresh", expires: Date.now() + 3_600_000 };
			},
		);
		const storage = freshStorage();
		using temp = TempDir.createSync("@scient-codex-plugins-oauth-");
		const outcome = await reauthorizeMcpServer(
			NAME,
			{ filePath: path.join(temp.path(), "mcp.json"), scope: "user", config, discovered: true },
			{ authStorage: storage, silent: true },
		);
		expect(probed[0]).toMatchObject({ url: SERVER_URL, headers: { "X-Team": placeholder } });
		expect(flows[0]?.scopes).toBeUndefined();
		// Discovery's `scope=admin` is dropped from the authorization URL.
		expect(storage.credentials.get(credentialId)).toMatchObject({
			access: "fresh",
			resource: "https://resource.example.test/",
			authorizationUrl: "https://auth.example.test/authorize",
		});
		expect(storage.credentials.get(oauthFlow.mcpOAuthCredentialId(SERVER_URL))).toBeUndefined();
		// Found by its fixed id: nothing is written to a config file, and the auth block stays.
		expect(outcome).toMatchObject({ persisted: false, credentialId, config: { auth: { credentialId } } });
		expect(await Bun.file(path.join(temp.path(), "mcp.json")).exists()).toBe(false);
	});

	it("reconnects on its own sign-in, and never stands in for another entry at its URL", async () => {
		const updateServerConfig = vi.fn(() => undefined);
		const manager = createMcpManagerStub({
			getServerConfig: vi.fn(() => boundConfig()),
			updateServerConfig,
			reconnectServer: vi.fn(async () => null),
			getConnectionStatus: vi.fn(() => "connected" as const),
		});
		expect(await reconnectMcpManagerServer(manager, NAME, boundConfig())).toBe("connected");
		expect(updateServerConfig).toHaveBeenCalledWith(NAME, boundConfig());
		// A definition without that sign-in is another server, even at the same URL.
		expect(await reconnectMcpManagerServer(manager, NAME, { type: "http", url: SERVER_URL })).toBeUndefined();
	});

	it("signs out of its own sign-in alone", async () => {
		const storage = freshStorage();
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		await storage.credentials.set(credentialId, token);
		await storage.credentials.set(oauthFlow.mcpOAuthCredentialId(SERVER_URL), { ...token, access: "native" });
		using temp = TempDir.createSync("@scient-codex-plugins-unauth-");
		const previous = getProjectDir();
		setProjectDir(temp.path());
		try {
			const ctx = createInteractiveModeContext({
				session: { modelRegistry: { authStorage: storage } },
				mcpManager: createMcpManagerStub({
					getServerConfig: vi.fn(() => boundConfig()),
					getSource: vi.fn(() => ({
						provider: "codex-plugins",
						providerName: "Codex Plugins",
						path: "/codex/plugin/.mcp.json",
						level: "user" as const,
					})),
				}),
			});
			await new MCPCommandController(ctx).handle(`/mcp unauth ${NAME}`);
			expect(ctx.showError).not.toHaveBeenCalled();
		} finally {
			setProjectDir(previous);
		}
		expect(storage.credentials.get(credentialId)).toBeUndefined();
		// Another server's sign-in at the same URL stays.
		expect(storage.credentials.get(oauthFlow.mcpOAuthCredentialId(SERVER_URL))).toMatchObject({ access: "native" });
	});

	it("asks for a fresh sign-in once the plugin configures another confidential OAuth client", async () => {
		const storage = freshStorage();
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		const stored: oauthFlow.MCPStoredOAuthCredential = { ...token, clientId: "client-a" };
		await storage.credentials.set(credentialId, stored);
		const withClient = (clientId: string, clientSecret?: string): MCPServerConfig => ({
			...boundConfig(),
			oauth: { clientId, ...(clientSecret !== undefined && { clientSecret }) },
		});
		expect(lookupMcpOAuthCredential(storage, withClient("client-a", "s"))?.credentialId).toBe(credentialId);
		// Client A's token is neither sent nor refreshed for client B, nor for an ID that differs only in spaces.
		expect(lookupMcpOAuthCredential(storage, withClient("client-b", "s"))).toBeUndefined();
		expect(lookupMcpOAuthCredential(storage, withClient("client-a ", "s"))).toBeUndefined();
		// Codex holds only a confidential client (one with a secret) to its ID.
		expect(lookupMcpOAuthCredential(storage, withClient("client-b"))?.credentialId).toBe(credentialId);
		// A server with no sign-in of its own is looked up as before, whatever its client settings hold.
		const urlKeyed = oauthFlow.mcpOAuthCredentialId(SERVER_URL);
		await storage.credentials.set(urlKeyed, {
			...token,
			clientId: "registered",
		} as oauthFlow.MCPStoredOAuthCredential);
		const ordinary = (clientId: unknown) =>
			({ type: "http", url: SERVER_URL, oauth: { clientId, clientSecret: "s" } }) as never;
		expect(lookupMcpOAuthCredential(storage, ordinary("configured"))?.credentialId).toBe(urlKeyed);
		expect(lookupMcpOAuthCredential(storage, ordinary(7))?.credentialId).toBe(urlKeyed);
	});

	it("binds a definition only by the source supplied with it, never one left registered", async () => {
		const storage = freshStorage();
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		await storage.credentials.set(credentialId, { ...token, access: "own" });
		const probed: MCPServerConfig[] = [];
		vi.spyOn(mcpClient, "connectToServer").mockImplementation((async (_name: string, probe: MCPServerConfig) => {
			probed.push(probe);
			throw new Error("unreachable");
		}) as never);
		using temp = TempDir.createSync("@scient-codex-plugins-provenance-");
		const manager = new MCPManager(temp.path());
		manager.setAuthStorage(storage);
		const imported = {
			provider: "codex-plugins",
			providerName: "Codex Plugins",
			path: "/p/.mcp.json",
			level: "user" as const,
		};
		// The imported server fails to connect, which leaves its source registered under the name.
		await manager.connectServers({ [NAME]: boundConfig() }, { [NAME]: imported });
		// A definition arriving without a source (a config file's) names the same sign-in.
		await manager.connectServers({ [NAME]: boundConfig() }, {});
		expect(probed).toHaveLength(2);
		expect(probed[0]).toMatchObject({ headers: { Authorization: "Bearer own" } });
		expect(probed[1]).not.toMatchObject({ headers: { Authorization: expect.anything() } });
		await manager.disconnectAll();
	});

	it("leaves a server's own token in charge, as Codex does", async () => {
		const storage = freshStorage();
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		await storage.credentials.set(credentialId, token);
		// A configured Authorization header wins over a stored sign-in.
		expect(
			lookupMcpOAuthCredential(storage, {
				type: "http",
				url: SERVER_URL,
				headers: { Authorization: "Bearer service" },
				auth: { type: "oauth", credentialId },
			}),
		).toBeUndefined();
		// A server declaring bearer_token_env_var is bound as a key: no sign-in answers it, and none starts.
		const keyed: MCPServerConfig = { ...boundConfig(), auth: { type: "apikey", credentialId } };
		expect(lookupMcpOAuthCredential(storage, keyed)).toBeUndefined();
		using temp = TempDir.createSync("@scient-codex-plugins-keyed-");
		await expect(
			reauthorizeMcpServer(
				NAME,
				{ filePath: path.join(temp.path(), "mcp.json"), scope: "user", config: keyed, discovered: true },
				{ authStorage: storage, silent: true },
			),
		).rejects.toBeInstanceOf(McpReauthRefusalError);
	});

	it("gives a sign-in to no definition but its own server's", async () => {
		const storage = freshStorage();
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		await storage.credentials.set(credentialId, token);
		// Repointed to another URL, the id answers nothing.
		expect(
			lookupMcpOAuthCredentialForServer(storage, { type: "oauth", credentialId }, "https://other.example.test/mcp"),
		).toBeUndefined();
		using temp = TempDir.createSync("@scient-codex-plugins-claim-");
		const filePath = path.join(temp.path(), "mcp.json");
		// A config-file definition, or one under another name, cannot sign in under it.
		for (const [name, discovered] of [
			[NAME, false],
			["copy", true],
		] as const) {
			await expect(
				reauthorizeMcpServer(
					name,
					{ filePath, scope: "user", config: boundConfig(), discovered },
					{ authStorage: storage, silent: true },
				),
			).rejects.toBeInstanceOf(McpReauthRefusalError);
		}
		// Nor sign it out.
		const previous = getProjectDir();
		setProjectDir(temp.path());
		try {
			const ctx = createInteractiveModeContext({
				session: { modelRegistry: { authStorage: storage } },
				mcpManager: createMcpManagerStub({
					getServerConfig: vi.fn(() => boundConfig()),
					getSource: vi.fn(() => ({
						provider: "codex-plugins",
						providerName: "Codex Plugins",
						path: "/codex/plugin/.mcp.json",
						level: "user" as const,
					})),
				}),
			});
			await new MCPCommandController(ctx).handle("/mcp unauth copy");
			expect(ctx.showError).toHaveBeenCalledWith(expect.stringContaining("belongs to another server"));
		} finally {
			setProjectDir(previous);
		}
		expect(storage.credentials.get(credentialId)).toMatchObject({ access: "a" });
		// Only the codex-plugins source binds a definition to a server's own sign-in, even under the id
		// the definition's own name and URL give.
		const ownId = oauthFlow.mcpOAuthServerCredentialId("imposter", SERVER_URL);
		await Bun.write(
			path.join(temp.path(), ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					copy: { type: "http", url: SERVER_URL, auth: { type: "oauth", credentialId } },
					imposter: { type: "http", url: SERVER_URL, auth: { type: "oauth", credentialId: ownId } },
					// A malformed id belongs to no one; it must not stop its siblings from loading.
					numeric: { type: "http", url: SERVER_URL, auth: { type: "apikey", credentialId: 5 } },
				},
			}),
		);
		const release = initializeWithSettings(Settings.isolated());
		try {
			const { configs } = await loadAllMCPConfigs(temp.path());
			expect(configs.copy?.auth?.credentialId).toBeUndefined();
			expect(configs.imposter?.auth?.credentialId).toBeUndefined();
			expect(configs.numeric).toMatchObject({ type: "http", url: SERVER_URL });
		} finally {
			release();
		}
		// Manual connections (/mcp test) apply the same rule to the definition they read.
		expect(oauthFlow.withTrustedMcpAuth(NAME, boundConfig(), "codex-plugins").auth?.credentialId).toBe(credentialId);
		expect(oauthFlow.withTrustedMcpAuth(NAME, boundConfig(), "mcp-json").auth?.credentialId).toBeUndefined();
		expect(oauthFlow.withTrustedMcpAuth("copy", boundConfig(), "codex-plugins").auth?.credentialId).toBeUndefined();
	});

	it("toggles an imported server through the disabled-servers list", async () => {
		using temp = TempDir.createSync("@scient-codex-plugins-toggle-");
		const previousProject = getProjectDir();
		const previousAgent = getAgentDir();
		setProjectDir(temp.path());
		setAgentDir(temp.join("agent"));
		try {
			const ctx = createInteractiveModeContext({
				session: { modelRegistry: { authStorage: freshStorage() } },
				mcpManager: createMcpManagerStub({
					getServerConfig: vi.fn(() => boundConfig()),
					getSource: vi.fn(() => ({
						provider: "codex-plugins",
						providerName: "Codex Plugins",
						path: "/codex/plugin/.mcp.json",
						level: "user" as const,
					})),
				}),
			});
			await new MCPCommandController(ctx).handle(`/mcp disable ${NAME}`);
			expect(ctx.showError).not.toHaveBeenCalled();
			expect(await readDisabledServers(getMCPConfigPath("user", temp.path()))).toEqual([NAME]);
		} finally {
			setProjectDir(previousProject);
			setAgentDir(previousAgent);
		}
	});

	it("answers a live imported server's sign-in challenge for that server, not a same-named file entry", async () => {
		using temp = TempDir.createSync("@scient-codex-plugins-challenge-");
		const previousProject = getProjectDir();
		const previousAgent = getAgentDir();
		setProjectDir(temp.path());
		setAgentDir(temp.join("agent"));
		// A config-file entry of the same name, which a lookup by name alone would pick.
		await Bun.write(
			getMCPConfigPath("project", temp.path()),
			JSON.stringify({ mcpServers: { [NAME]: { type: "http", url: SERVER_URL } } }),
		);
		const connect = vi.spyOn(mcpClient, "connectToServer").mockRejectedValue(new Error("HTTP 401"));
		const storage = freshStorage();
		const credentialId = oauthFlow.mcpOAuthServerCredentialId(NAME, SERVER_URL);
		try {
			const ctx = createInteractiveModeContext({
				session: { modelRegistry: { authStorage: storage } },
				mcpManager: createMcpManagerStub({
					// The live server names its own token, so no OAuth sign-in may start for it.
					getServerConfig: vi.fn(() => ({ ...boundConfig(), auth: { type: "apikey" as const, credentialId } })),
					getSource: vi.fn(() => ({
						provider: "codex-plugins",
						providerName: "Codex Plugins",
						path: "/codex/plugin/.mcp.json",
						level: "user" as const,
					})),
				}),
			});
			const challenge = { wwwAuthenticate: ['Bearer scope="read"'] };
			expect(await new MCPCommandController(ctx).handleMCPAuthChallenge(NAME, challenge)).toBeUndefined();
		} finally {
			setProjectDir(previousProject);
			setAgentDir(previousAgent);
		}
		// Refused before any probe: the file entry was never signed in.
		expect(connect).not.toHaveBeenCalled();
		expect(storage.credentials.get(oauthFlow.mcpOAuthCredentialId(SERVER_URL))).toBeUndefined();
	});
});
