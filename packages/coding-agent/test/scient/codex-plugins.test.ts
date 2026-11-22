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
import { StdioTransport } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import * as piUtils from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery";

const ENV_KEYS = [
	"SCIENT_AGENT_ENABLE_SOURCES",
	"CODEX_HOME",
	"CODEX_PLUGIN_TEST_TOKEN",
	"CODEX_PLUGIN_TEST_PAT",
	"CODEX_PLUGIN_TEST_SECRET",
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
		expect([...byName.keys()].sort()).toEqual(["research:papers", "research:quiet", "research:tracker"]);
		expect(byName.get("research:papers")).toMatchObject({
			command: path.join(researchRoot, "bin", "papers"),
			args: ["--stdio"],
			cwd: researchRoot,
			envPolicy: "literal",
			timeout: 30_000,
			transport: "stdio",
		});
		// Codex passes its own short list plus the server's env_vars, never the whole environment.
		const papers = byName.get("research:papers");
		expect(papers?.envInherit).toEqual([]);
		expect(papers?.env).toMatchObject({ PATH: process.env.PATH, CODEX_PLUGIN_TEST_TOKEN: "forwarded-value" });
		expect(papers?.env?.CODEX_PLUGIN_TEST_PAT).toBeUndefined();
		expect(byName.get("research:tracker")).toMatchObject({
			url: "https://mcp.example.test/mcp",
			headers: { Authorization: "Bearer pat-value" },
			headerPolicy: "origin-locked",
			transport: "http",
		});
		// The plugin's config table turns this server off, as Codex does.
		expect(byName.get("research:quiet")?.enabled).toBe(false);
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
			names: result.items.filter(server => server.name.startsWith("limits:")).map(server => server.name),
			warnings: result.warnings.filter(warning => warning.includes("of limits@market")),
		};
	};

	it("skips a plugin's server whose tools Codex narrows with enabled_tools", async () => {
		await installLimits({
			narrow: { command: "node", args: ["narrow.mjs"], enabled_tools: ["search"] },
			open: { command: "node", args: ["open.mjs"], disabled_tools: [] },
		});
		expect(await limits()).toEqual({
			names: ["limits:open"],
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
		expect(names).toEqual(["limits:approved"]);
		expect(warnings).toContainEqual(expect.stringContaining("tools.save.approval_mode"));
		expect(warnings).toContainEqual(expect.stringContaining("default_tools_approval_mode"));
	});

	it("skips a server whose config.toml policy narrows its tools with disabled_tools", async () => {
		await installLimits(
			{ denied: { command: "node", args: ["denied.mjs"] }, open: { command: "node", args: ["open.mjs"] } },
			['[plugins."limits@market".mcp_servers.denied]', 'disabled_tools = ["delete"]'],
		);
		expect(await limits()).toEqual({
			names: ["limits:open"],
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
			names: ["limits:open"],
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
		expect([...(await load()).byName.keys()]).toEqual(["opted:one"]);
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
		expect([...byName.keys()].filter(name => name.startsWith("strict:"))).toEqual(["strict:signin"]);
		expect(byName.get("strict:signin")).toMatchObject({
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
		expect([...byName.keys()].filter(name => name.startsWith("paths:")).sort()).toEqual([
			"paths:fromPath",
			"paths:literal",
		]);
		// Origin-locked headers and literal env are never resolved as variables or `!commands`.
		expect(byName.get("paths:literal")).toMatchObject({
			headers: { "X-Run": "!touch /tmp/pwned" },
			headerPolicy: "origin-locked",
		});
		expect(byName.get("paths:fromPath")).toMatchObject({
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
		expect([...byName.keys()].some(name => name.startsWith("linked:"))).toBe(false);
		expect(warnings).toContainEqual(expect.stringContaining("Ignoring mcpServers path outside linked@market"));
	});

	it("keeps same-named plugins from different marketplaces apart, whatever their names", async () => {
		const server = { mcpServers: { api: { command: "node" } } };
		await install("twin@alpha", { ".codex-plugin/plugin.json": { name: "twin" }, ".mcp.json": server });
		await install("twin@beta", { ".codex-plugin/plugin.json": { name: "twin" }, ".mcp.json": server });
		// Its name is what `twin` qualified with `alpha` would look like if dots qualified names.
		await install("twin.alpha@gamma", { ".codex-plugin/plugin.json": { name: "twin.alpha" }, ".mcp.json": server });
		expect([...(await load()).byName.keys()].filter(name => name.startsWith("twin")).sort()).toEqual([
			"twin.alpha:api",
			"twin:alpha:api",
			"twin:beta:api",
		]);
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
		expect(byName.get("rules:off")?.enabled).toBe(false);
		// Codex turns an ema_auth server off for good, so it is not listed for a setting to turn on.
		expect(byName.has("rules:retired")).toBe(false);
		expect(warnings).toContainEqual(
			expect.stringContaining('"retired" of rules@market: Codex turns it off (ema_auth)'),
		);
		expect(byName.has("rules:numeric")).toBe(false);
		expect(warnings).toContainEqual(expect.stringContaining('"numeric" of rules@market: invalid command'));
		expect(byName.get("rules:withheld")?.env).toMatchObject({ KEEP: "y" });
		expect(byName.get("rules:withheld")?.env?.NODE_REPL_AUTH_TOKEN).toBeUndefined();
		expect(byName.get("rules:withheld")?.env?.openai_spiffe_id).toBeUndefined();
		expect(byName.has("linkedfolder:x")).toBe(false);
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
		expect(byName.has("portable2:events")).toBe(false);
		expect(byName.get("portable2:local")?.env).toMatchObject({ CODEX_PLUGIN_TEST_PAT: "pat-value", MODE: "x" });
		expect(byName.has("linkedmcp:y")).toBe(false);
		expect(warnings).toContainEqual(expect.stringContaining("linkedmcp@market: mcp.json is not a regular file"));
	});

	it("forwards a variable only from a valid .codex-plugin declaration of the same stdio server", async () => {
		const placeholder = "$" + "{CODEX_PLUGIN_TEST_PAT}";
		const standard = (name: string) => ({
			"plugin.json": { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name },
			"mcp.json": {
				$schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
				mcpServers: {
					local: { type: "stdio", command: "node", args: [name], env: { CODEX_PLUGIN_TEST_PAT: placeholder } },
				},
			},
		});
		await install("viaclaude@market", {
			...standard("viaclaude"),
			".claude-plugin/plugin.json": { name: "viaclaude" },
			".mcp.json": { mcpServers: { local: { command: "node", env_vars: ["CODEX_PLUGIN_TEST_PAT"] } } },
		});
		await install("invalidoverlay@market", {
			...standard("invalidoverlay"),
			".codex-plugin/plugin.json": { name: "invalidoverlay" },
			".mcp.json": {
				mcpServers: {
					local: { command: "node", url: "https://mcp.example.test/mcp", env_vars: ["CODEX_PLUGIN_TEST_PAT"] },
				},
			},
		});
		await install("textflag@market", {
			...standard("textflag"),
			".codex-plugin/plugin.json": { name: "textflag" },
			".mcp.json": {
				mcpServers: { local: { command: "node", enabled: "false", env_vars: ["CODEX_PLUGIN_TEST_PAT"] } },
			},
		});
		const { byName } = await load();
		expect(byName.get("viaclaude:local")?.env?.CODEX_PLUGIN_TEST_PAT).toBe(placeholder);
		expect(byName.get("invalidoverlay:local")?.env?.CODEX_PLUGIN_TEST_PAT).toBe(placeholder);
		expect(byName.get("textflag:local")?.env?.CODEX_PLUGIN_TEST_PAT).toBe(placeholder);
	});

	it("skips a manifest Codex cannot read and paths it would not take", async () => {
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
		expect(byName.has("typed:x")).toBe(false);
		expect(byName.has("loose:y")).toBe(false);
		expect(warnings).toContainEqual(expect.stringContaining("Invalid plugin.json for typed@market (name)"));
		expect(warnings).toContainEqual(expect.stringContaining("Ignoring mcpServers path of loose@market"));
		const names = (await skills()).map(skill => skill.name);
		expect(names).not.toContain("typed-skill");
		expect(names).not.toContain("loose-skill");
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
		expect(byName.get("portable:remote")).toMatchObject({ transport: "http", headerPolicy: "origin-locked" });
		expect(byName.has("portable:legacy")).toBe(false);
		expect(byName.has("clauded:tool")).toBe(true);
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
