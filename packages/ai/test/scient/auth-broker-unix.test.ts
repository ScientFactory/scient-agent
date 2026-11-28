import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { openAuthCredentialStore, resolveAuthBrokerConfig } from "@oh-my-pi/pi-ai/auth-broker/discover";
import { unixBrokerCredentials } from "../../src/scient/auth-broker-unix";
import { removeWithRetries } from "../../../utils/src/temp";

const TOKEN = "synthetic-local-broker-token";

async function fixture() {
	const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ab-"));
	const socket = path.join(dir, "s");
	const tokenFile = path.join(dir, "auth-broker.token");
	return { dir, socket, tokenFile, url: `unix:${socket}`, [Symbol.asyncDispose]: () => removeWithRetries(dir) };
}

const onUnix = test.skipIf(process.platform !== "darwin" && process.platform !== "linux");

onUnix("authenticates snapshot pulls and streams through a private socket", async () => {
	await using state = await fixture();
	await fs.writeFile(state.tokenFile, TOKEN, { mode: 0o600 });
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	try {
		await store.saveOAuth("openai-codex", {
			access: "synthetic-access",
			refresh: "synthetic-refresh",
			expires: Date.now() + 3_600_000,
		});
		await storage.credentials.reload();
		const handle = startAuthBroker({
			storage,
			bind: state.url,
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
		try {
			const credentials = await unixBrokerCredentials(handle.url);
			if (!credentials) throw new Error("expected Unix broker credentials");
			const client = new AuthBrokerClient(credentials);
			const snapshot = await client.fetchSnapshot();
			expect(snapshot).toMatchObject({
				status: 200,
				snapshot: { credentials: [{ provider: "openai-codex", credential: { access: "synthetic-access" } }] },
			});
			const stream = client.openSnapshotStream({ signal: AbortSignal.timeout(3000) });
			try {
				expect(await stream.next()).toMatchObject({ done: false, value: { kind: "snapshot" } });
			} finally {
				await stream.return(undefined);
			}
			const unauthorized = new AuthBrokerClient({ url: state.url, token: "incorrect", maxRetries: 0 });
			await expect(unauthorized.fetchSnapshot()).rejects.toMatchObject({ status: 401 });
		} finally {
			await handle.close();
		}
	} finally {
		storage.close();
		store.close();
	}
});

onUnix("refuses a nonprivate socket directory or token file", async () => {
	await using state = await fixture();
	await fs.chmod(state.dir, 0o755);
	expect(() => new AuthBrokerClient({ url: state.url, token: TOKEN })).toThrow("private directory");
	await fs.chmod(state.dir, 0o700);
	await fs.writeFile(state.tokenFile, TOKEN, { mode: 0o600 });
	await fs.chmod(state.tokenFile, 0o644);
	await expect(unixBrokerCredentials(state.url)).rejects.toThrow("private file");
});

test.skipIf(process.platform !== "darwin")("rejects ACL grants even when POSIX mode is private", async () => {
	await using state = await fixture();
	const grant = Bun.spawnSync(["/bin/chmod", "+a", "everyone allow search", state.dir]);
	expect(grant.exitCode).toBe(0);
	expect(() => new AuthBrokerClient({ url: state.url, token: TOKEN })).toThrow("granting macOS ACLs");
});

onUnix("auto-discovery preserves explicit brokers and routes only ChatGPT to the default", async () => {
	await using state = await fixture();
	await fs.writeFile(state.tokenFile, TOKEN, { mode: 0o600 });
	const app = path.join(state.dir, "app");
	await fs.mkdir(app, { mode: 0o700 });
	const brokerStore = new SqliteAuthCredentialStore(new Database(":memory:"));
	const brokerStorage = new AuthStorage(brokerStore);
	let handle: AuthBrokerServerHandle | undefined;
	try {
		await brokerStore.saveOAuth("openai-codex", {
			access: "shared-access",
			refresh: "shared-refresh",
			expires: Date.now() + 3_600_000,
		});
		await brokerStore.upsertAuthCredential("anthropic", { type: "api_key", key: "broker-only-key" });
		await brokerStorage.credentials.reload();
		handle = startAuthBroker({
			storage: brokerStorage,
			bind: state.url,
			bearerTokens: [TOKEN],
			disableRefresher: true,
		});
		const config = await resolveAuthBrokerConfig({ agentDir: app, devChatGptBrokerUrl: state.url });
		expect(config?.sharedProvider).toBe("openai-codex");
		if (!config) throw new Error("expected scoped dev broker");
		const client = new AuthBrokerClient(config);
		const snapshot = await client.fetchSnapshot();
		expect(snapshot.status === 200 && snapshot.snapshot.credentials.map(row => row.provider)).toEqual([
			"openai-codex",
		]);
		await expect(
			client.uploadCredential("anthropic", { type: "api_key", key: "do-not-store" }),
		).rejects.toMatchObject({
			status: 403,
		});
		const { store } = await openAuthCredentialStore({
			brokerConfig: config,
			agentDir: app,
			cachePath: path.join(app, "snapshot"),
		});
		try {
			expect(store.listAuthCredentials().map(row => row.provider)).toEqual(["openai-codex"]);
			await store.upsertAuthCredential("anthropic", { type: "api_key", key: "app-only-key" });
			expect(store.listAuthCredentials("anthropic")).toMatchObject([{ credential: { key: "app-only-key" } }]);
			expect(brokerStore.listAuthCredentials("anthropic")).toMatchObject([
				{ credential: { key: "broker-only-key" } },
			]);
		} finally {
			store.close?.();
		}
		await handle.close();
		handle = undefined;
		const disconnected = await openAuthCredentialStore({
			brokerConfig: config,
			agentDir: app,
			cachePath: path.join(app, "uncached"),
		});
		try {
			expect(disconnected.store.listAuthCredentials("anthropic")).toMatchObject([
				{ credential: { key: "app-only-key" } },
			]);
		} finally {
			disconnected.store.close?.();
		}
		await fs.writeFile(
			path.join(app, "config.yml"),
			"auth:\n  broker:\n    url: https://example.invalid\n    token: local-only\n",
		);
		expect(await resolveAuthBrokerConfig({ agentDir: app, devChatGptBrokerUrl: state.url })).toEqual({
			url: "https://example.invalid",
			token: "local-only",
		});
	} finally {
		await handle?.close();
		brokerStorage.close();
		brokerStore.close();
	}
});

onUnix("does not follow an HTTP redirect off the Unix socket", async () => {
	await using state = await fixture();
	let httpRequests = 0;
	const http = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => {
			httpRequests++;
			return new Response(null);
		},
	});
	const unix = Bun.serve({ unix: state.socket, fetch: () => Response.redirect(http.url.href) });
	try {
		const client = new AuthBrokerClient({ url: state.url, token: TOKEN, maxRetries: 0 });
		await expect(client.fetchSnapshot()).rejects.toThrow();
		expect(httpRequests).toBe(0);
	} finally {
		unix.stop(true);
		http.stop(true);
	}
});
