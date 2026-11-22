import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { initializeWithSettings, loadCapability } from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { cfgEnabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { resolveMCPRequestDeadline } from "@oh-my-pi/pi-coding-agent/mcp/timeout";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { HttpTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/http";
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import type { MCPRequestOptions, MCPServerConnection, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import * as piUtils from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery";

const ENV_KEYS = [
	"SCIENT_AGENT_ENABLE_SOURCES",
	"CODEX_HOME",
	"CODEX_PLUGIN_TEST_TOKEN",
	"CODEX_PLUGIN_TEST_PAT",
	"CODEX_PLUGIN_TEST_SECRET",
	"CODEX_PLUGIN_TEST_NEWLINE",
];

async function writeSkill(root: string, name: string): Promise<string> {
	const skillPath = path.join(root, "skills", name, "SKILL.md");
	await Bun.write(skillPath, `---\nname: ${name}\ndescription: ${name} skill\n---\nUse ${name}.\n`);
	return skillPath;
}

async function writeManifest(root: string, manifest: Record<string, unknown>): Promise<void> {
	await Bun.write(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
}

describe("installed Codex plugins", () => {
	let temp: piUtils.TempDir;
	let settings: Settings;
	let release: () => void;
	let saved: Record<string, string | undefined>;
	let cwd: string;
	let agentDir: string;
	let researchRoot: string;
	let researchSkill: string;

	beforeEach(async () => {
		saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
		for (const key of ENV_KEYS) restoreEnvValue(key, undefined);
		settings = Settings.isolated();
		release = initializeWithSettings(settings);
		temp = piUtils.TempDir.createSync("@scient-codex-plugins-");
		const home = temp.join("home");
		const codexHome = temp.join("codex-home");
		cwd = temp.join("project");
		agentDir = temp.join("agent");
		await fs.mkdir(cwd, { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		restoreEnvValue("CODEX_HOME", codexHome);
		restoreEnvValue("CODEX_PLUGIN_TEST_TOKEN", "forwarded-value");
		restoreEnvValue("CODEX_PLUGIN_TEST_PAT", "pat-value");
		// The loader reads the environment Bun started with, which a test cannot change afterwards;
		// the test's live environment stands in for it (the real one is tested in a fresh process).
		vi.spyOn(piUtils, "getLaunchEnv").mockImplementation(() => ({ ...process.env }) as Record<string, string>);

		await Bun.write(
			path.join(codexHome, "config.toml"),
			[
				'[plugins."research@market"]',
				"enabled = true",
				'[plugins."research@market".mcp_servers.quiet]',
				"enabled = false",
				'[plugins."paused@market"]',
				"enabled = false",
				'[plugins."browser@openai-bundled"]',
				"enabled = true",
				"",
			].join("\n"),
		);
		const cache = path.join(codexHome, "plugins", "cache");
		const research = path.join(cache, "market", "research");
		researchRoot = path.join(research, "1.10.0");
		const olderRoot = path.join(research, "1.2.0");
		for (const root of [researchRoot, olderRoot]) {
			await writeManifest(root, {
				name: "research",
				skills: "./skills/",
				mcpServers: "./.mcp.json",
				apps: "./.app.json",
				interface: { displayName: "Research" },
			});
		}
		researchSkill = await writeSkill(researchRoot, "lit-review");
		await writeSkill(olderRoot, "stale-review");
		// Codex ignores links in the cache (bundled plugins ship a `latest` link to a version).
		await fs.symlink(olderRoot, path.join(research, "latest"), "dir");
		await Bun.write(
			path.join(researchRoot, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					papers: {
						command: "./bin/papers",
						args: ["--stdio"],
						cwd: ".",
						env_vars: ["CODEX_PLUGIN_TEST_TOKEN"],
						tool_timeout_sec: 30,
					},
					tracker: {
						type: "http",
						url: "https://mcp.example.test/mcp",
						bearer_token_env_var: "CODEX_PLUGIN_TEST_PAT",
					},
					quiet: { command: "node", args: ["./quiet.mjs"] },
					messages: { command: "./bin/computer-use-client-launcher", args: ["messages", "mcp"], cwd: "." },
				},
			}),
		);
		await Bun.write(
			path.join(researchRoot, ".app.json"),
			JSON.stringify({ apps: { research: { id: "asdk_app_x" } } }),
		);

		const paused = path.join(cache, "market", "paused", "1.0.0");
		await writeManifest(paused, { name: "paused", skills: "./skills/" });
		await writeSkill(paused, "paused-skill");

		const browser = path.join(cache, "openai-bundled", "browser", "26.1117.41037");
		await writeManifest(browser, { name: "browser", skills: "./skills/" });
		await writeSkill(browser, "control-in-app-browser");
		// The loader reports symlink-resolved paths (macOS temp folders live under /private).
		researchRoot = await fs.realpath(researchRoot);
		researchSkill = await fs.realpath(researchSkill);
		clearFsCache();
	});

	afterEach(() => {
		release();
		for (const key of ENV_KEYS) restoreEnvValue(key, saved[key]);
		vi.restoreAllMocks();
		clearFsCache();
		temp.removeSync();
	});

	const skills = async () =>
		(await loadCapability<Skill>("skills", { cwd, agentDir })).items.filter(
			skill => skill._source.provider === "codex-plugins",
		);
	const servers = async () =>
		(await loadCapability<MCPServer>("mcps", { cwd, agentDir })).items.filter(
			server => server._source.provider === "codex-plugins",
		);

	it("loads nothing until the host or settings enable codex-plugins", async () => {
		cfgEnabledProviders.set(settings, ["codex", "claude"]);
		expect(await skills()).toEqual([]);
		expect(await servers()).toEqual([]);
	});

	it("loads the active version's skills and MCP servers with package-relative paths", async () => {
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "codex-plugins");

		// Only the enabled, installed plugin's highest version: not the disabled plugin, the
		// host-only browser plugin, the older version or the `latest` link to it.
		expect((await skills()).map(skill => [skill.name, skill.path])).toEqual([["lit-review", researchSkill]]);

		const byName = new Map((await servers()).map(server => [server.name, server]));
		// The Computer Use client launcher runs only inside Codex.
		expect([...byName.keys()].sort()).toEqual(["research@market:papers", "research@market:tracker"]);
		expect(byName.get("research@market:papers")).toMatchObject({
			command: path.join(researchRoot, "bin", "papers"),
			args: ["--stdio"],
			cwd: researchRoot,
			envPolicy: "literal",
			// tool_timeout_sec is a hard cap on tool calls, not the stretchable request timeout.
			toolTimeoutMs: 30_000,
			transport: "stdio",
		});
		// Codex passes its own short list plus the server's env_vars, never the whole environment.
		const papers = byName.get("research@market:papers");
		expect(papers?.envInherit).toEqual([]);
		expect(papers?.timeout).toBeUndefined();
		expect(papers?.env).toMatchObject({ PATH: process.env.PATH, CODEX_PLUGIN_TEST_TOKEN: "forwarded-value" });
		expect(papers?.env?.CODEX_PLUGIN_TEST_PAT).toBeUndefined();
		expect(byName.get("research@market:tracker")).toMatchObject({
			url: "https://mcp.example.test/mcp",
			headers: { Authorization: "Bearer pat-value" },
			headerPolicy: "origin-locked",
			transport: "http",
			// It names its own token, so it is bound as a key: no OAuth sign-in replaces the bearer.
			auth: { type: "apikey" },
		});
		// The plugin's config table turns this server off in Codex for good, so it is not listed.
		expect(byName.has("research@market:quiet")).toBe(false);
	});

	/**
	 * Installs and enables `limits@market` with these servers and config.toml lines after its table;
	 * returns its `.mcp.json`.
	 */
	async function installLimits(mcpServers: Record<string, unknown>, policy: string[] = []): Promise<string> {
		const codexHome = temp.join("codex-home");
		const configPath = path.join(codexHome, "config.toml");
		const config = await Bun.file(configPath).text();
		await Bun.write(configPath, [config, '[plugins."limits@market"]', "enabled = true", ...policy, ""].join("\n"));
		const root = path.join(codexHome, "plugins", "cache", "market", "limits", "1.0.0");
		await writeManifest(root, { name: "limits" });
		const mcpPath = path.join(root, ".mcp.json");
		await Bun.write(mcpPath, JSON.stringify({ mcpServers }));
		clearFsCache();
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "codex-plugins");
		return fs.realpath(mcpPath);
	}
	const limits = async () => {
		const result = await loadCapability<MCPServer>("mcps", { cwd, agentDir });
		return {
			names: result.items.filter(server => server.name.startsWith("limits@market:")).map(server => server.name),
			warnings: result.warnings.filter(warning => warning.includes("of limits@market")),
		};
	};

	it("skips a plugin's server whose tools Codex narrows with enabled_tools", async () => {
		await installLimits({
			narrow: { command: "node", args: ["narrow.mjs"], enabled_tools: ["search"] },
			open: { command: "node", args: ["open.mjs"], disabled_tools: [] },
		});
		expect(await limits()).toEqual({
			names: ["limits@market:open"],
			warnings: [
				'[Codex Plugins] [codex-plugins] Skipping MCP server "narrow" of limits@market: Codex restricts its tools (enabled_tools), which Scient Agent cannot enforce',
			],
		});
	});

	it("skips a server whose tools Codex asks about before running them", async () => {
		await installLimits(
			{
				writes: { command: "node", args: ["writes.mjs"], tools: { save: { approval_mode: "writes" } } },
				prompted: { command: "node", args: ["prompted.mjs"] },
				approved: { command: "node", args: ["approved.mjs"], default_tools_approval_mode: "approve" },
			},
			['[plugins."limits@market".mcp_servers.prompted]', 'default_tools_approval_mode = "prompt"'],
		);
		const { names, warnings } = await limits();
		expect(names).toEqual(["limits@market:approved"]);
		expect(warnings).toContainEqual(expect.stringContaining("tools.save.approval_mode"));
		expect(warnings).toContainEqual(expect.stringContaining("default_tools_approval_mode"));
	});

	it("skips a server Codex hides from the model or would not start", async () => {
		// A value HTTP does not allow is skipped, so it cannot displace the static header Codex keeps.
		restoreEnvValue("CODEX_PLUGIN_TEST_NEWLINE", "account-b\n");
		await installLimits({
			hidden: { command: "node", args: ["hidden.mjs"], omit_tools_from: ["direct", "deferred", "code_mode"] },
			negative: { command: "node", args: ["negative.mjs"], startup_timeout_sec: -1 },
			// One past u64::MAX, which Codex's startup_timeout_ms cannot hold.
			huge: { command: "node", args: ["huge.mjs"], startup_timeout_ms: 2 ** 64 },
			// Codex times out every tool call of this one.
			instant: { command: "node", args: ["instant.mjs"], tool_timeout_sec: 0 },
			capped: { command: "node", args: ["capped.mjs"], tools: { read: { output_token_limit: 100 } } },
			shown: { command: "node", args: ["shown.mjs"], omit_tools_from: [] },
			// Codex refuses to start a server whose named bearer variable is unset.
			unsetbearer: { url: "https://mcp.example.test/a", bearer_token_env_var: "CODEX_PLUGIN_TEST_UNSET" },
			// The bearer replaces a static header of the same name in any case.
			cased: {
				url: "https://mcp.example.test/b",
				http_headers: { authorization: "Basic old" },
				bearer_token_env_var: "CODEX_PLUGIN_TEST_PAT",
			},
			kept: {
				url: "https://mcp.example.test/c",
				http_headers: { "X-Account": "account-a", "Bad Name": "x" },
				env_http_headers: { "X-Account": "CODEX_PLUGIN_TEST_NEWLINE" },
			},
			// Codex compares a confidential client's stored ID with this one exactly, which Scient would trim.
			spacedclient: { url: "https://mcp.example.test/d", oauth: { client_id: " id ", client_secret: "s" } },
			// Codex refuses a client secret without a client ID.
			secretonly: { url: "https://mcp.example.test/e", oauth: { client_secret: "s" } },
			// Codex rejects an empty secret, which must not pass as no secret at all.
			emptysecret: { url: "https://mcp.example.test/f", oauth: { client_id: "id", client_secret: "" } },
			spacedsecret: { url: "https://mcp.example.test/g", oauth: { client_id: "id", client_secret: " s" } },
			// Enterprise sign-in settings Codex allows only with ema_auth.
			issuer: { url: "https://mcp.example.test/h", oauth: { authorization_server_issuer: "https://idp.test" } },
		});
		const { names, warnings } = await limits();
		expect(names.sort()).toEqual(["limits@market:cased", "limits@market:kept", "limits@market:shown"]);
		const byName = (await load()).byName;
		expect(byName.get("limits@market:cased")?.headers).toEqual({ Authorization: "Bearer pat-value" });
		expect(byName.get("limits@market:kept")?.headers).toEqual({ "X-Account": "account-a" });
		// Codex's five-minute default holds a server that sets no tool_timeout_sec.
		expect(byName.get("limits@market:shown")?.toolTimeoutMs).toBe(300_000);
		expect(warnings).toContainEqual(expect.stringContaining('"spacedclient" of limits@market: its OAuth client_id'));
		expect(warnings).toContainEqual(
			expect.stringContaining('"secretonly" of limits@market: its OAuth client_secret has no client_id'),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining('"emptysecret" of limits@market: its OAuth client_secret'),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining(
				'"spacedsecret" of limits@market: its OAuth client_id or client_secret has surrounding',
			),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining('"issuer" of limits@market: its OAuth authorization_server_issuer needs ema_auth'),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining('"unsetbearer" of limits@market: its bearer_token_env_var CODEX_PLUGIN_TEST_UNSET'),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining('"hidden" of limits@market: Codex restricts its tools (omit_tools_from)'),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining('"negative" of limits@market: invalid startup_timeout_sec'),
		);
		expect(warnings).toContainEqual(
			expect.stringContaining(
				'"capped" of limits@market: Codex restricts its tools (tools.read.output_token_limit)',
			),
		);
		expect(warnings).toContainEqual(expect.stringContaining('"instant" of limits@market: Codex times out each'));
	});

	it("holds a tool call to tool_timeout_sec whatever its arguments ask", () => {
		// A call asking to wait 10 s still ends at the configured 2 s, as in Codex.
		const args = { arguments: { wait_seconds: 10 } };
		expect(resolveMCPRequestDeadline(undefined, "tools/call", args, 2_000)).toEqual({
			timeoutMs: 2_000,
			maxTotalMs: 2_000,
		});
		// Other requests keep their own timeout.
		expect(resolveMCPRequestDeadline(undefined, "tools/list", undefined, 2_000).timeoutMs).not.toBe(2_000);
	});

	// The cap is the transport's own timer on a live socket, which fake timers do not drive: the test
	// waits on no fixed delay, only on that cap (300 ms at most) firing.
	it("keeps a tool call's cap across an HTTP sign-in refresh and retry", async () => {
		let posts = 0;
		const server = Bun.serve({
			port: 0,
			async fetch(req) {
				await req.json();
				posts++;
				// The first attempt is refused; the retry is never answered.
				return posts === 1 ? new Response("expired", { status: 401 }) : new Promise<Response>(() => {});
			},
		});
		const call = async (refresh: () => Promise<Record<string, string> | null>) => {
			posts = 0;
			const transport = new HttpTransport({
				type: "http",
				url: `http://127.0.0.1:${server.port}/mcp`,
				toolTimeoutMs: 300,
			});
			await transport.connect();
			transport.onAuthError = refresh;
			try {
				return await transport.request("tools/call", { name: "slow", arguments: {} }).then(
					() => "resolved",
					(error: Error) => error.message,
				);
			} finally {
				await transport.close();
			}
		};
		try {
			// A refresh that never ends still ends the call at the cap.
			expect(await call(() => new Promise(() => {}))).toBe("Request timeout after 300ms");
			// A refresh that takes 200 ms of the cap leaves the retry the rest, not a fresh 300 ms.
			const realNow = Date.now;
			let skew = 0;
			vi.spyOn(Date, "now").mockImplementation(() => realNow() + skew);
			const message = await call(async () => {
				skew = 200;
				return { Authorization: "Bearer refreshed" };
			});
			expect(Number(/Request timeout after (\d+)ms/.exec(message)?.[1])).toBeLessThanOrEqual(100);
		} finally {
			server.stop(true);
		}
	});

	it("replays a tool call after reconnecting only within the call's own deadline", async () => {
		const deadlines: (number | undefined)[] = [];
		const transport = (respond: () => Promise<unknown>): MCPTransport => ({
			connected: true,
			request: (async (_method: string, _params: unknown, options?: MCPRequestOptions) => {
				deadlines.push(options?.deadlineAt);
				return respond();
			}) as MCPTransport["request"],
			async notify() {},
			async close() {},
		});
		const connection = (respond: () => Promise<unknown>): MCPServerConnection => ({
			name: "tools@market:api",
			config: { type: "http", url: "https://mcp.example.test/mcp", toolTimeoutMs: 300_000 },
			transport: transport(respond),
			serverInfo: { name: "api", version: "1" },
			capabilities: { tools: {} },
		});
		const unavailable = new MCPTransportError({
			transport: "http",
			stage: "receive",
			failure: "http_status",
			message: "HTTP 503: busy",
			retryable: true,
			code: 503,
		});
		const definition = { name: "run", inputSchema: { type: "object" as const } };
		const ctx = {} as Parameters<MCPTool["execute"]>[3];
		// A 503 reconnects and replays the call: the replay keeps the first attempt's deadline.
		const replayed = new MCPTool(
			connection(async () => Promise.reject(unavailable)),
			definition,
			async () => connection(async () => ({ content: [{ type: "text", text: "ok" }] })),
		);
		await replayed.execute("call", {}, () => {}, ctx);
		expect(deadlines).toHaveLength(2);
		expect(deadlines[0]).toBeNumber();
		expect(deadlines[1]).toBe(deadlines[0]);
		// A reconnect still pending at the deadline ends the call with its own error, never a replay.
		deadlines.length = 0;
		const stalled = new MCPTool(
			{
				...connection(async () => Promise.reject(unavailable)),
				config: { type: "http", url: "https://x.test/", toolTimeoutMs: 1 },
			},
			definition,
			() => new Promise<never>(() => {}),
		);
		const result = await stalled.execute("call", {}, () => {}, ctx);
		expect(result.isError).toBe(true);
		expect(deadlines).toHaveLength(1);
	});

	it("skips a server whose config.toml policy narrows its tools with disabled_tools", async () => {
		await installLimits(
			{ denied: { command: "node", args: ["denied.mjs"] }, open: { command: "node", args: ["open.mjs"] } },
			['[plugins."limits@market".mcp_servers.denied]', 'disabled_tools = ["delete"]'],
		);
		expect(await limits()).toEqual({
			names: ["limits@market:open"],
			warnings: [
				'[Codex Plugins] [codex-plugins] Skipping MCP server "denied" of limits@market: Codex restricts its tools (disabled_tools), which Scient Agent cannot enforce',
			],
		});
	});

	it("skips a malformed server and keeps its siblings", async () => {
		const mcpPath = await installLimits({
			bad: { command: "node", env_vars: "CODEX_PLUGIN_TEST_TOKEN" },
			headers: { url: "https://mcp.example.test/mcp", http_headers: ["X-Bad"] },
			open: { command: "node", args: ["open.mjs"] },
		});
		expect(await limits()).toEqual({
			names: ["limits@market:open"],
			warnings: [
				`[Codex Plugins] [codex-plugins] Skipping MCP server "bad" of limits@market: invalid env_vars (${mcpPath})`,
				`[Codex Plugins] [codex-plugins] Skipping MCP server "headers" of limits@market: invalid http_headers (${mcpPath})`,
			],
		});
	});

	/** Installs `<name>@<marketplace>` with this manifest file and extra files; returns its real root. */
	async function install(
		id: string,
		files: Record<string, unknown>,
		configLines: string[] = ["enabled = true"],
	): Promise<string> {
		const [name, marketplace] = id.split("@");
		const codexHome = temp.join("codex-home");
		const configPath = path.join(codexHome, "config.toml");
		const config = await Bun.file(configPath).text();
		await Bun.write(configPath, [config, `[plugins."${id}"]`, ...configLines, ""].join("\n"));
		const root = path.join(codexHome, "plugins", "cache", marketplace!, name!, "1.0.0");
		for (const [file, content] of Object.entries(files)) {
			await Bun.write(path.join(root, file), typeof content === "string" ? content : JSON.stringify(content));
		}
		clearFsCache();
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "codex-plugins");
		return fs.realpath(root);
	}
	const load = async () => {
		const result = await loadCapability<MCPServer>("mcps", { cwd, agentDir });
		return {
			byName: new Map(
				result.items.filter(server => server._source.provider === "codex-plugins").map(s => [s.name, s]),
			),
			warnings: result.warnings,
		};
	};

	it("follows [plugins._default]: a table without enabled inherits it", async () => {
		const server = { mcpServers: { one: { command: "node" } } };
		await install("inherits@market", { ".codex-plugin/plugin.json": { name: "inherits" }, ".mcp.json": server });
		await install("opted@market", { ".codex-plugin/plugin.json": { name: "opted" }, ".mcp.json": server });
		await Bun.write(
			path.join(temp.join("codex-home"), "config.toml"),
			[
				"[plugins._default]",
				"enabled = false",
				// A table with only a server policy and no `enabled` takes the default.
				'[plugins."inherits@market".mcp_servers.one]',
				"enabled = true",
				'[plugins."opted@market"]',
				"enabled = true",
				"",
			].join("\n"),
		);
		clearFsCache();
		expect([...(await load()).byName.keys()]).toEqual(["opted@market:one"]);
	});

	it("rejects servers Codex would reject and maps OAuth client settings", async () => {
		await install("strict@market", {
			".codex-plugin/plugin.json": { name: "strict" },
			".mcp.json": {
				mcpServers: {
					both: { command: "node", url: "https://mcp.example.test/mcp" },
					argsOnHttp: { url: "https://mcp.example.test/mcp", args: ["x"] },
					helper: { url: "https://mcp.example.test/mcp", http_headers_helper: "./headers.sh" },
					ema: { url: "https://mcp.example.test/mcp", auth: "ema_auth" },
					signin: {
						type: "http",
						url: "https://mcp.example.test/mcp",
						oauth_resource: "https://mcp.example.test/mcp",
						scopes: ["read", "write"],
						oauth: { clientId: "client-1", callback_port: 4567 },
						note: "unknown fields are ignored, as in Codex",
					},
				},
			},
		});
		const { byName, warnings } = await load();
		expect([...byName.keys()].filter(name => name.startsWith("strict@market:"))).toEqual(["strict@market:signin"]);
		expect(byName.get("strict@market:signin")).toMatchObject({
			oauth: { clientId: "client-1", callbackPort: 4567, scope: "read write" },
			auth: { type: "oauth", resource: "https://mcp.example.test/mcp" },
		});
		expect(warnings.filter(w => w.includes("of strict@market"))).toEqual([
			expect.stringContaining('"both" of strict@market: url is not supported for stdio'),
			expect.stringContaining('"argsOnHttp" of strict@market: args is not supported for streamable HTTP'),
			expect.stringContaining('"helper" of strict@market: it computes its headers with a helper command'),
			expect.stringContaining('"ema" of strict@market: auth ema_auth is not supported'),
		]);
	});

	it("takes plugin values literally and keeps launch paths inside the package", async () => {
		const root = await install("paths@market", {
			".codex-plugin/plugin.json": { name: "paths" },
			".mcp.json": {
				mcpServers: {
					literal: { url: "https://mcp.example.test/mcp", http_headers: { "X-Run": "!touch /tmp/pwned" } },
					upCwd: { command: "node", cwd: "../.." },
					upCommand: { command: "../../../other/bin/server" },
					fromPath: { command: "node", env: { MODE: "CODEX_PLUGIN_TEST_PAT" } },
				},
			},
		});
		const { byName, warnings } = await load();
		expect([...byName.keys()].filter(name => name.startsWith("paths@market:")).sort()).toEqual([
			"paths@market:fromPath",
			"paths@market:literal",
		]);
		// Origin-locked headers and literal env are never resolved as variables or `!commands`.
		expect(byName.get("paths@market:literal")).toMatchObject({
			headers: { "X-Run": "!touch /tmp/pwned" },
			headerPolicy: "origin-locked",
		});
		expect(byName.get("paths@market:fromPath")).toMatchObject({
			command: "node",
			cwd: root,
			env: { MODE: "CODEX_PLUGIN_TEST_PAT" },
			envPolicy: "literal",
		});
		const reasons = warnings.filter(w => w.includes("of paths@market"));
		expect(reasons).toEqual([
			expect.stringContaining('"upCwd" of paths@market: cwd ../.. leaves the package'),
			expect.stringContaining('"upCommand" of paths@market: command ../../../other/bin/server leaves the package'),
		]);
	});

	it("does not follow a skills or MCP file link out of the package", async () => {
		const outside = temp.join("outside");
		await writeSkill(outside, "leaked");
		await Bun.write(path.join(outside, "servers.json"), JSON.stringify({ mcpServers: { x: { command: "node" } } }));
		const root = await install("linked@market", {
			".codex-plugin/plugin.json": { name: "linked", mcpServers: "./servers.json" },
		});
		await fs.symlink(path.join(outside, "skills"), path.join(root, "skills"), "dir");
		await fs.symlink(path.join(outside, "servers.json"), path.join(root, "servers.json"));
		clearFsCache();
		expect((await skills()).map(skill => skill.name)).toEqual(["lit-review"]);
		const { byName, warnings } = await load();
		expect([...byName.keys()].some(name => name.startsWith("linked@market:"))).toBe(false);
		expect(warnings).toContainEqual(expect.stringContaining("Ignoring mcpServers path outside linked@market"));
	});

	it("keeps same-named plugins from different marketplaces apart, whatever their names", async () => {
		await install("twin@alpha", {
			".codex-plugin/plugin.json": { name: "twin" },
			".mcp.json": { mcpServers: { a: { command: "node" } } },
		});
		await install("twin@beta", {
			".codex-plugin/plugin.json": { name: "twin" },
			".mcp.json": { mcpServers: { b: { command: "node" } } },
		});
		// Its name is what `twin` qualified with `alpha` would look like if dots qualified names.
		await install("twin.alpha@gamma", {
			".codex-plugin/plugin.json": { name: "twin.alpha" },
			".mcp.json": { mcpServers: { c: { command: "node" } } },
		});
		expect([...(await load()).byName.keys()].filter(name => name.startsWith("twin")).sort()).toEqual([
			"twin.alpha@gamma:c",
			"twin@alpha:a",
			"twin@beta:b",
		]);
	});

	it("runs none of the servers two enabled plugins declare under one name", async () => {
		const server = { mcpServers: { api: { command: "node" } } };
		await install("first@market", { ".codex-plugin/plugin.json": { name: "first" }, ".mcp.json": server });
		await install("second@market", { ".codex-plugin/plugin.json": { name: "second" }, ".mcp.json": server });
		const { byName, warnings } = await load();
		expect(byName.has("first@market:api")).toBe(false);
		expect(byName.has("second@market:api")).toBe(false);
		expect(warnings).toContainEqual(
			expect.stringContaining('"api" of first@market: second@market declares a server of that name too'),
		);
	});

	it("matches skill rules to the name Codex gives a plugin's skills, and only that name", async () => {
		for (const id of ["twin@alpha", "twin@beta"]) {
			const root = await install(id, { ".codex-plugin/plugin.json": { name: "twin" } });
			await writeSkill(root, "search");
		}
		// A blank manifest name leaves Codex the package folder's name, the version.
		const blank = await install("blank@market", { ".codex-plugin/plugin.json": { name: "  " } });
		await writeSkill(blank, "find");
		// A manifest name of Unicode whitespace alone is blank to Codex too.
		const nel = await install("nel@market", { ".codex-plugin/plugin.json": { name: "\u0085" } });
		await writeSkill(nel, "nel-skill");
		// Codex collapses the name's inner whitespace before a rule meets it.
		await writeSkill(blank, "Paper  Search");
		// A skill without a frontmatter name takes its folder's, collapsed the same way.
		await Bun.write(path.join(blank, "skills", "daily  review", "SKILL.md"), "---\ndescription: d\n---\nRun.\n");
		const configPath = temp.join("codex-home", "config.toml");
		const rules = [
			"[[skills.config]]",
			// Codex trims a selector's Unicode whitespace, U+0085 included.
			'name = "\\u0085twin:search\\u0085"',
			"enabled = false",
			// Codex names no plugin skill bare `search`, so this enables nothing.
			"[[skills.config]]",
			'name = "search"',
			"enabled = true",
			"[[skills.config]]",
			'name = "1.0.0:find"',
			"enabled = false",
			"[[skills.config]]",
			'name = "1.0.0:Paper Search"',
			"enabled = false",
			"[[skills.config]]",
			'name = "1.0.0:daily review"',
			"enabled = false",
			"[[skills.config]]",
			'name = "1.0.0:nel-skill"',
			"enabled = false",
			"",
		];
		await Bun.write(configPath, [await Bun.file(configPath).text(), ...rules].join("\n"));
		clearFsCache();
		const names = (await skills()).map(skill => skill.name);
		expect(names).not.toContain("search");
		expect(names).not.toContain("find");
		expect(names.some(name => name.startsWith("Paper"))).toBe(false);
		expect(names.some(name => name.startsWith("daily"))).toBe(false);
		expect(names).not.toContain("nel-skill");
	});

	it("loads no plugin from a [plugins] table Codex cannot read", async () => {
		const configPath = temp.join("codex-home", "config.toml");
		const original = await Bun.file(configPath).text();
		for (const [line, field] of [
			['enabled = "false"', "strict@market.enabled"],
			['auto_provision = "yes"', "strict@market.auto_provision"],
			["apps.connector = false", "strict@market.apps.connector"],
			[
				'apps.connector.tools.list.approval_mode = "sometimes"',
				"strict@market.apps.connector.tools.list.approval_mode",
			],
		]) {
			await Bun.write(configPath, original);
			await install("strict@market", { ".codex-plugin/plugin.json": { name: "strict" } }, [line]);
			const { byName, warnings } = await load();
			expect(byName.size).toBe(0);
			expect(warnings).toContainEqual(expect.stringContaining(`cannot read its [plugins] settings (${field})`));
		}
	});

	it("follows Codex's home, plugins switch and own server settings", async () => {
		const codexHome = temp.join("codex-home");
		const configPath = path.join(codexHome, "config.toml");
		const original = await Bun.file(configPath).text();
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "codex-plugins");
		// Codex opens CODEX_HOME exactly as set: with a trailing space it names another folder.
		restoreEnvValue("CODEX_HOME", `${codexHome} `);
		let result = await load();
		expect(result.byName.size).toBe(0);
		expect(result.warnings).toContainEqual(expect.stringContaining("which is not a folder"));
		restoreEnvValue("CODEX_HOME", codexHome);
		// `[features] plugins = false` turns every plugin off.
		await Bun.write(configPath, `${original}\n[features]\nplugins = false\n`);
		clearFsCache();
		result = await load();
		expect(result.byName.size).toBe(0);
		expect(result.warnings).toContainEqual(expect.stringContaining("plugins are turned off"));
		// The config's own [mcp_servers.papers] is what Codex runs, not the plugin's server.
		await Bun.write(configPath, `${original}\n[mcp_servers.papers]\ncommand = "node"\nenabled = false\n`);
		clearFsCache();
		result = await load();
		expect(result.byName.has("research@market:papers")).toBe(false);
		expect(result.byName.has("research@market:tracker")).toBe(true);
		expect(result.warnings).toContainEqual(
			expect.stringContaining("Codex runs your own [mcp_servers.papers] instead"),
		);
	});

	it.skipIf(process.platform === "win32")(
		"reads a backslash as part of a file name outside Windows, as Codex does",
		async () => {
			await install("slashed@market", {
				".codex-plugin/plugin.json": { name: "slashed", mcpServers: "./sub\\..\\.mcp.json" },
				".mcp.json": { mcpServers: { fallback: { command: "node" } } },
			});
			const { byName, warnings } = await load();
			// Codex takes the path, finds no such file, and does not fall back to .mcp.json.
			expect(byName.has("slashed@market:fallback")).toBe(false);
			expect(warnings).toContainEqual(expect.stringContaining("Missing mcpServers file declared by slashed@market"));
		},
	);

	it("leaves out plugin skills the user's Codex config disables", async () => {
		const root = await fs.realpath(await install("ruled@market", { ".codex-plugin/plugin.json": { name: "ruled" } }));
		for (const name of ["off-by-path", "off-by-name", "back-on", "kept"]) await writeSkill(root, name);
		const configPath = temp.join("codex-home", "config.toml");
		const rules = [
			"[[skills.config]]",
			`path = ${JSON.stringify(path.join(root, "skills", "off-by-path", "SKILL.md"))}`,
			"enabled = false",
			"[[skills.config]]",
			'name = "ruled:off-by-name"',
			"enabled = false",
			// A later entry for the same selector replaces the earlier one.
			"[[skills.config]]",
			'name = "back-on"',
			"enabled = false",
			"[[skills.config]]",
			'name = "back-on"',
			"enabled = true",
		];
		await Bun.write(configPath, [await Bun.file(configPath).text(), ...rules, ""].join("\n"));
		clearFsCache();
		const names = (await skills()).filter(skill => skill.path.startsWith(root)).map(skill => skill.name);
		expect(names.sort()).toEqual(["back-on", "kept"]);
	});

	it("reads the launch environment only where the process can know it", async () => {
		const first = temp.join("first-project");
		const second = temp.join("second-project");
		await Bun.write(path.join(first, ".env"), "CODEX_HOME=/from/dotenv\nCODEX_PLUGIN_TEST_SECRET=dotenv-secret\n");
		await Bun.write(path.join(first, ".env.local"), "CODEX_PLUGIN_TEST_LOCAL=local-secret\n");
		await fs.mkdir(second, { recursive: true });
		// A fresh process, so the dotenv files load at its own startup in `first`.
		const utils = path.join(import.meta.dir, "../../../utils/src/index.ts");
		const script = [
			`const { getLaunchEnv, setProjectDir } = await import(${JSON.stringify(utils)});`,
			`setProjectDir(${JSON.stringify(second)});`,
			"const env = getLaunchEnv();",
			"console.log(JSON.stringify([Bun.env.CODEX_HOME, env && [env.CODEX_HOME, env.CODEX_PLUGIN_TEST_SECRET, env.CODEX_PLUGIN_TEST_LOCAL, env.CODEX_PLUGIN_TEST_PAT]]));",
		].join("\n");
		// JSON writes a missing value as null.
		const launch = [null, null, null, "exported"];
		// With --no-env-file only the agent's own loader reads .env, after the snapshot. Without it
		// Bun autoloads .env and .env.local first, as when the agent runs from source; only Linux's
		// procfs still holds the launch environment then.
		for (const [flags, expected] of [
			[["--no-env-file"], launch],
			[[], process.platform === "linux" ? launch : null],
			// Bun loads a file it is told to even with --no-env-file.
			[["--no-env-file", "--env-file=.env"], null],
		] as const) {
			const run = Bun.spawnSync([process.execPath, ...flags, "-e", script], {
				cwd: first,
				env: { PATH: process.env.PATH, HOME: temp.join("home"), CODEX_PLUGIN_TEST_PAT: "exported" },
			});
			expect(JSON.parse(run.stdout.toString().trim().split("\n").at(-1) ?? "null")).toEqual([
				"/from/dotenv",
				expected,
			]);
		}
	});

	it("loads nothing while the launch environment is unknown", async () => {
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "codex-plugins");
		vi.spyOn(piUtils, "getLaunchEnv").mockReturnValue(undefined);
		const { byName, warnings } = await load();
		expect(byName.size).toBe(0);
		expect(await skills()).toEqual([]);
		expect(warnings).toContainEqual(expect.stringContaining("start it with --no-env-file"));
	});

	it("follows Codex on disabled declarations, withheld variables and linked package folders", async () => {
		await install(
			"rules@market",
			{
				".codex-plugin/plugin.json": { name: "rules" },
				".mcp.json": {
					mcpServers: {
						off: { command: "node", enabled: false },
						retired: { command: "node", args: ["retired.mjs"] },
						numeric: { command: 7, url: "https://mcp.example.test/mcp" },
						withheld: {
							command: "node",
							env: { NODE_REPL_AUTH_TOKEN: "x", openai_spiffe_id: "lower", KEEP: "y" },
						},
					},
				},
			},
			["enabled = true", '[plugins."rules@market".mcp_servers.retired]', "ema_auth = true"],
		);
		const outside = temp.join("outside-manifest");
		await Bun.write(path.join(outside, "plugin.json"), JSON.stringify({ name: "linkedfolder" }));
		const linkedRoot = await install("linkedfolder@market", {
			".mcp.json": { mcpServers: { x: { command: "node" } } },
		});
		await fs.symlink(outside, path.join(linkedRoot, ".codex-plugin"), "dir");
		clearFsCache();
		const { byName, warnings } = await load();
		expect(byName.has("rules@market:off")).toBe(false);
		expect(warnings).toContainEqual(
			expect.stringContaining('"off" of rules@market: Codex turns it off (enabled = false)'),
		);
		// Codex turns an ema_auth server off for good, so it is not listed for a setting to turn on.
		expect(byName.has("rules@market:retired")).toBe(false);
		expect(warnings).toContainEqual(
			expect.stringContaining('"retired" of rules@market: Codex turns it off (ema_auth)'),
		);
		expect(byName.has("rules@market:numeric")).toBe(false);
		expect(warnings).toContainEqual(expect.stringContaining('"numeric" of rules@market: invalid command'));
		expect(byName.get("rules@market:withheld")?.env).toMatchObject({ KEEP: "y" });
		expect(byName.get("rules@market:withheld")?.env?.NODE_REPL_AUTH_TOKEN).toBeUndefined();
		expect(byName.get("rules@market:withheld")?.env?.openai_spiffe_id).toBeUndefined();
		expect(byName.has("linkedfolder@market:x")).toBe(false);
		expect(warnings).toContainEqual(
			expect.stringContaining("Ignoring linkedfolder@market: .codex-plugin is not a folder"),
		);
	});

	it("contains every skill in its package and finds nested ones", async () => {
		const outside = temp.join("outside-skill");
		await writeSkill(outside, "escaped");
		const root = await fs.realpath(await install("mixed@market", { ".codex-plugin/plugin.json": { name: "mixed" } }));
		await writeSkill(root, "inside");
		await writeSkill(path.join(root, "skills", "group"), "nested");
		await fs.symlink(path.join(outside, "skills", "escaped"), path.join(root, "skills", "escaped"), "dir");
		await fs.mkdir(path.join(root, "skills", "filelink"));
		await fs.symlink(
			path.join(outside, "skills", "escaped", "SKILL.md"),
			path.join(root, "skills", "filelink", "SKILL.md"),
		);
		clearFsCache();
		const found = (await skills()).filter(skill => skill.path.startsWith(root));
		expect(found.map(skill => skill.name).sort()).toEqual(["inside", "nested"]);
		// skill:// resolves the skill's other files inside the package too.
		expect(found.every(skill => skill.containRoot === root)).toBe(true);
	});

	it("applies Codex's rules to an Agent Plugins package's mcp.json", async () => {
		restoreEnvValue("CODEX_PLUGIN_TEST_PAT", "pat-value");
		const schema = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
		await install("portable2@market", {
			"plugin.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable2" },
			"mcp.json": {
				$schema: schema,
				mcpServers: {
					events: { type: "sse", url: "https://mcp.example.test/sse" },
					local: {
						type: "stdio",
						command: "node",
						env: { CODEX_PLUGIN_TEST_PAT: "$" + "{CODEX_PLUGIN_TEST_PAT}", MODE: "x" },
					},
				},
			},
			// The package's legacy declaration forwards the variable the placeholder stands for.
			".codex-plugin/plugin.json": { name: "portable2" },
			".mcp.json": { mcpServers: { local: { command: "node", env_vars: ["CODEX_PLUGIN_TEST_PAT"] } } },
		});
		const linked = await install("linkedmcp@market", {
			"plugin.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "linkedmcp" },
			"real-mcp.json": { $schema: schema, mcpServers: { y: { type: "stdio", command: "node" } } },
		});
		await fs.symlink(path.join(linked, "real-mcp.json"), path.join(linked, "mcp.json"));
		clearFsCache();
		const { byName, warnings } = await load();
		expect(byName.has("portable2@market:events")).toBe(false);
		expect(byName.get("portable2@market:local")?.env).toMatchObject({
			CODEX_PLUGIN_TEST_PAT: "pat-value",
			MODE: "x",
		});
		expect(byName.has("linkedmcp@market:y")).toBe(false);
		// mcp.json carries no tool_timeout_sec, so Codex's five-minute default holds its tool calls.
		expect(byName.get("portable2@market:local")?.toolTimeoutMs).toBe(300_000);
		expect(warnings).toContainEqual(expect.stringContaining("linkedmcp@market: mcp.json is not a regular file"));
	});

	it("forwards a variable only from a valid .codex-plugin declaration of the same stdio server", async () => {
		const placeholder = "$" + "{CODEX_PLUGIN_TEST_PAT}";
		const standard = (name: string) => ({
			"plugin.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name },
			"mcp.json": {
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					[name]: { type: "stdio", command: "node", env: { CODEX_PLUGIN_TEST_PAT: placeholder } },
				},
			},
		});
		await install("viaclaude@market", {
			...standard("viaclaude"),
			".claude-plugin/plugin.json": { name: "viaclaude" },
			".mcp.json": { mcpServers: { viaclaude: { command: "node", env_vars: ["CODEX_PLUGIN_TEST_PAT"] } } },
		});
		await install("invalidoverlay@market", {
			...standard("invalidoverlay"),
			".codex-plugin/plugin.json": { name: "invalidoverlay" },
			".mcp.json": {
				mcpServers: {
					invalidoverlay: {
						command: "node",
						url: "https://mcp.example.test/mcp",
						env_vars: ["CODEX_PLUGIN_TEST_PAT"],
					},
				},
			},
		});
		await install("textflag@market", {
			...standard("textflag"),
			".codex-plugin/plugin.json": { name: "textflag" },
			".mcp.json": {
				mcpServers: { textflag: { command: "node", enabled: "false", env_vars: ["CODEX_PLUGIN_TEST_PAT"] } },
			},
		});
		const { byName } = await load();
		expect(byName.get("viaclaude@market:viaclaude")?.env?.CODEX_PLUGIN_TEST_PAT).toBe(placeholder);
		expect(byName.get("invalidoverlay@market:invalidoverlay")?.env?.CODEX_PLUGIN_TEST_PAT).toBe(placeholder);
		expect(byName.get("textflag@market:textflag")?.env?.CODEX_PLUGIN_TEST_PAT).toBe(placeholder);
	});

	it("skips a manifest Codex cannot read and falls back as Codex does from paths it would not take", async () => {
		const root = await install("typed@market", {
			".codex-plugin/plugin.json": { name: 5 },
			".mcp.json": { mcpServers: { x: { command: "node" } } },
		});
		await writeSkill(root, "typed-skill");
		const loose = await install("loose@market", {
			".codex-plugin/plugin.json": { name: "loose", skills: "skills/", mcpServers: "./sub/../.mcp.json" },
			".mcp.json": { mcpServers: { y: { command: "node" } } },
		});
		await writeSkill(loose, "loose-skill");
		clearFsCache();
		const { byName, warnings } = await load();
		expect(byName.has("typed@market:x")).toBe(false);
		expect(warnings).toContainEqual(expect.stringContaining("Invalid plugin.json for typed@market (name)"));
		// Codex drops both paths and reads the package's skills/ and .mcp.json instead.
		expect(byName.has("loose@market:y")).toBe(true);
		expect(warnings).toContainEqual(expect.stringContaining("Ignoring mcpServers of loose@market"));
		const names = (await skills()).map(skill => skill.name);
		expect(names).not.toContain("typed-skill");
		expect(names).toContain("loose-skill");
	});

	it("reads Codex's manifest precedence: a root Agent Plugins manifest, then the legacy folders", async () => {
		await install("portable@market", {
			"plugin.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable" },
			".codex-plugin/plugin.json": { name: "portable", mcpServers: { legacy: { command: "node" } } },
			"mcp.json": {
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: { remote: { type: "streamable-http", url: "https://mcp.example.test/mcp" } },
			},
		});
		await install("clauded@market", {
			".claude-plugin/plugin.json": { name: "clauded" },
			".mcp.json": { mcpServers: { tool: { command: "node" } } },
		});
		const { byName } = await load();
		expect(byName.get("portable@market:remote")).toMatchObject({ transport: "http", headerPolicy: "origin-locked" });
		expect(byName.has("portable@market:legacy")).toBe(false);
		expect(byName.has("clauded@market:tool")).toBe(true);
	});

	it("starts a stdio server with only the variables Codex would pass", async () => {
		restoreEnvValue("CODEX_PLUGIN_TEST_SECRET", "must-not-leak");
		const out = temp.join("env.json");
		const transport = new StdioTransport({
			type: "stdio",
			command: process.execPath,
			args: ["-e", `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`],
			env: { MODE: "set" },
			envInherit: ["PATH", "CODEX_PLUGIN_TEST_TOKEN"],
		});
		// The script writes its environment and exits; the transport reports the exit.
		const exited = Promise.withResolvers<void>();
		transport.onClose = () => exited.resolve();
		try {
			await transport.connect();
			await exited.promise;
		} finally {
			await transport.close();
		}
		const seen = JSON.parse(await Bun.file(out).text()) as Record<string, string>;
		expect(seen.CODEX_PLUGIN_TEST_TOKEN).toBe("forwarded-value");
		expect(seen.MODE).toBe("set");
		expect(seen.CODEX_PLUGIN_TEST_SECRET).toBeUndefined();
		expect(seen.CODEX_PLUGIN_TEST_PAT).toBeUndefined();
	});
});
