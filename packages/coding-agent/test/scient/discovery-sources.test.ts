import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	disableUserSource,
	enableUserSource,
	getEnabledProviders,
	initializeWithSettings,
	isUserSourceEnabled,
	loadCapability,
} from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import type { Skill } from "@oh-my-pi/pi-coding-agent/capability/skill";
import { cfgDisabledProviders, cfgEnabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearClaudePluginRootsCache } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { restoreEnvValue } from "../helpers/settings-test-state";
import "@oh-my-pi/pi-coding-agent/discovery/claude-plugins";

describe("host discovery source additions", () => {
	let settings: Settings;
	let release: () => void;
	let savedSources: string | undefined;
	let savedClaudeDir: string | undefined;

	beforeEach(() => {
		savedSources = process.env.SCIENT_AGENT_ENABLE_SOURCES;
		savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", undefined);
		restoreEnvValue("CLAUDE_CONFIG_DIR", undefined);
		settings = Settings.isolated();
		release = initializeWithSettings(settings);
	});

	afterEach(() => {
		release();
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", savedSources);
		restoreEnvValue("CLAUDE_CONFIG_DIR", savedClaudeDir);
		vi.restoreAllMocks();
	});

	it("adds comma/whitespace-separated sources without losing settings opt-ins", () => {
		cfgEnabledProviders.set(settings, ["codex"]);
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "claude-plugins, cursor\n gemini\tclaude-plugins");
		for (const id of ["codex", "claude-plugins", "cursor", "gemini"]) {
			expect(isUserSourceEnabled(id), id).toBe(true);
		}
		expect(isUserSourceEnabled("windsurf")).toBe(false);
		expect(getEnabledProviders()).toEqual(["codex"]);
	});

	it("lets disabledProviders override an exact host opt-in and the claude alias", () => {
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "claude,claude-plugins");
		cfgDisabledProviders.set(settings, ["claude", "claude-plugins"]);
		expect(isUserSourceEnabled("claude")).toBe(false);
		expect(isUserSourceEnabled("claude-plugins")).toBe(false);
	});

	it("keeps discovery unchanged for absent, empty, or malformed additions", () => {
		cfgEnabledProviders.set(settings, ["codex"]);
		for (const value of [undefined, "", " , \t\n", ".claude CLAUDE claude/plugins 123 ! *invalid"]) {
			restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", value);
			expect(isUserSourceEnabled("codex")).toBe(true);
			expect(isUserSourceEnabled("claude")).toBe(false);
			expect(isUserSourceEnabled("claude-plugins")).toBe(false);
		}
	});

	it.each(["*", "all"])("honors the %s settings wildcard without overriding a disable", value => {
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", value);
		cfgDisabledProviders.set(settings, ["codex"]);
		expect(isUserSourceEnabled("cursor")).toBe(true);
		expect(isUserSourceEnabled("claude-plugins")).toBe(true);
		expect(isUserSourceEnabled("codex")).toBe(false);
	});

	it("persists only settings entries when sources are enabled and disabled", async () => {
		using temp = TempDir.createSync("scient-source-settings-");
		const agentDir = temp.join("agent");
		const cwd = temp.join("project");
		const config = path.join(agentDir, "config.yml");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(config, YAML.stringify({ enabledProviders: ["codex"] }));
		restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "claude-plugins");
		const persisted = await Settings.loadIsolated({ agentDir, cwd, configFiles: [] });
		const releasePersisted = initializeWithSettings(persisted);
		try {
			expect(getEnabledProviders()).toEqual(["codex"]);
			enableUserSource("gemini");
			disableUserSource("codex");
			disableUserSource("claude-plugins");
			await persisted.flush();
			expect(getEnabledProviders()).toEqual(["gemini"]);
			expect(cfgEnabledProviders.get(persisted)).toEqual(["gemini"]);
			expect(isUserSourceEnabled("claude-plugins")).toBe(true);
			expect((YAML.parse(await Bun.file(config).text()) as RawSettings).enabledProviders).toEqual(["gemini"]);
		} finally {
			releasePersisted();
			AgentStorage.close();
			Bun.gc(true);
		}
	});

	it("discovers a user Claude plugin through the host opt-in, including the claude alias", async () => {
		using temp = TempDir.createSync("scient-source-plugin-");
		const home = temp.join("home");
		const cwd = temp.join("project");
		const plugin = path.join(home, ".claude", "plugins", "cache", "market", "demo", "1.0.0");
		const skillPath = path.join(plugin, "skills", "host-demo", "SKILL.md");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(
			skillPath,
			"---\nname: host-demo\ndescription: Host-enabled plugin skill\n---\nUse this skill.\n",
		);
		await Bun.write(
			path.join(home, ".claude", "plugins", "installed_plugins.json"),
			JSON.stringify({
				version: 2,
				plugins: { "demo@market": [{ scope: "user", installPath: plugin, version: "1.0.0" }] },
			}),
		);
		vi.spyOn(os, "homedir").mockReturnValue(home);
		clearClaudePluginRootsCache();
		clearFsCache();
		const discover = async () => {
			const result = await loadCapability<Skill>("skills", { cwd, agentDir: temp.join("agent") });
			return result.items.find(skill => skill.name === "host-demo");
		};
		try {
			expect(await discover()).toBeUndefined();
			restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "claude-plugins");
			expect((await discover())?._source.provider).toBe("claude-plugins");
			restoreEnvValue("SCIENT_AGENT_ENABLE_SOURCES", "claude");
			expect((await discover())?.path).toBe(skillPath);
			cfgDisabledProviders.set(settings, ["claude-plugins"]);
			expect(await discover()).toBeUndefined();
		} finally {
			clearClaudePluginRootsCache();
			clearFsCache();
		}
	});
});
