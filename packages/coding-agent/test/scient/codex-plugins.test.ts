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
import { TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery";

const ENV_KEYS = ["SCIENT_AGENT_ENABLE_SOURCES", "CODEX_HOME", "CODEX_PLUGIN_TEST_TOKEN", "CODEX_PLUGIN_TEST_PAT"];

async function writeSkill(root: string, name: string): Promise<string> {
	const skillPath = path.join(root, "skills", name, "SKILL.md");
	await Bun.write(skillPath, `---\nname: ${name}\ndescription: ${name} skill\n---\nUse ${name}.\n`);
	return skillPath;
}

async function writeManifest(root: string, manifest: Record<string, unknown>): Promise<void> {
	await Bun.write(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest));
}

describe("installed Codex plugins", () => {
	let temp: TempDir;
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
		temp = TempDir.createSync("@scient-codex-plugins-");
		const home = temp.join("home");
		const codexHome = temp.join("codex-home");
		cwd = temp.join("project");
		agentDir = temp.join("agent");
		await fs.mkdir(cwd, { recursive: true });
		vi.spyOn(os, "homedir").mockReturnValue(home);
		restoreEnvValue("CODEX_HOME", codexHome);
		restoreEnvValue("CODEX_PLUGIN_TEST_TOKEN", "forwarded-value");
		restoreEnvValue("CODEX_PLUGIN_TEST_PAT", "pat-value");

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
			env: { CODEX_PLUGIN_TEST_TOKEN: "forwarded-value" },
			timeout: 30_000,
			transport: "stdio",
		});
		expect(byName.get("research:tracker")).toMatchObject({
			url: "https://mcp.example.test/mcp",
			headers: { Authorization: "Bearer pat-value" },
			transport: "http",
		});
		// The plugin's config table turns this server off, as Codex does.
		expect(byName.get("research:quiet")?.enabled).toBe(false);
	});
});
