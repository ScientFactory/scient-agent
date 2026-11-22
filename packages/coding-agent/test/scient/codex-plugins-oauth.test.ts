import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import * as mcpClient from "@oh-my-pi/pi-coding-agent/mcp/client";
import { lookupMcpOAuthCredentialForServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-credentials";
import * as oauthFlow from "@oh-my-pi/pi-coding-agent/mcp/oauth-flow";
import { reauthorizeMcpServer } from "@oh-my-pi/pi-coding-agent/mcp/oauth-reauth";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

const SERVER_URL = "https://mcp.example.test/mcp";
const NAME = "tools@market:api";
const placeholder = "$" + "{CODEX_PLUGIN_OAUTH_TEST}";

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
});
