/**
 * Installed Codex plugins (SA-CODEX-PLUGINS).
 *
 * Codex lists plugins in `$CODEX_HOME/config.toml` (default `~/.codex`) as
 * `[plugins."<name>@<marketplace>"]`, enabled unless the table says `enabled = false`, and runs
 * each from the active version of `$CODEX_HOME/plugins/cache/<marketplace>/<name>/<version>/`,
 * described by `.codex-plugin/plugin.json`. Their skills and MCP servers load here, MCP fields
 * mapped as the Codex config.toml reader maps them. App references (`.app.json`) do not: a
 * person's ChatGPT apps reach the agent through the ChatGPT sign-in (SA-CHATGPT-APPS). Plugins
 * and servers that run only inside OpenAI's own apps are left out.
 */
import * as path from "node:path";
import { $env, isRecord, logger } from "@oh-my-pi/pi-utils";
import { isUserSourceEnabled, registerProvider } from "../capability";
import { readDirEntries, readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { extractMCPServersFromToml } from "../discovery/codex";
import { createSourceMeta, scanSkillsFromDir } from "../discovery/helpers";

const PROVIDER_ID = "codex-plugins";
const DISPLAY_NAME = "Codex Plugins";
/** Below the `codex` provider (70), so a person's own `~/.codex` skills and servers win. */
const PRIORITY = 65;

/** The folder of a plugin Codex links from its source while it is developed; it wins over versions. */
const LOCAL_VERSION = "local";

/**
 * Bundled plugins that drive OpenAI's apps (the in-app browser, the Chrome extension host,
 * computer use, the Codex app's own threads) through services only those apps provide. Their
 * skills drive those services too.
 */
const HOST_PLUGINS: Record<string, true> = {
	"browser@openai-bundled": true,
	"chrome@openai-bundled": true,
	"codex-app-tools@openai-bundled": true,
	"computer-use@openai-bundled": true,
	"unified-computer-use@openai-bundled": true,
};

/** OpenAI's launcher for its signed Computer Use client, which serves only Codex (the Messages plugin). */
const HOST_LAUNCHER = "computer-use-client-launcher";

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface CodexPlugin {
	/** `<name>@<marketplace>`, the plugin's key in config.toml. */
	id: string;
	/** Plugin name: skill namespace and MCP server prefix. */
	name: string;
	/** The active version's folder; package-relative paths resolve against it. */
	root: string;
	manifestPath: string;
	manifest: Record<string, unknown>;
	/** The plugin's `[plugins."<id>"]` table. */
	config: Record<string, unknown>;
}

/** Codex's rule for a cache path segment (plugin, marketplace or version name). */
function isPathSegment(value: string): boolean {
	return value !== "." && value !== ".." && /^[A-Za-z0-9._+-]+$/.test(value);
}

/** Codex's version order: semantic versions by precedence, anything else by its characters. */
function compareVersions(a: string, b: string): number {
	if (SEMVER.test(a) && SEMVER.test(b)) {
		const order = Bun.semver.order(a, b);
		if (order !== 0) return order;
	}
	return a < b ? -1 : a > b ? 1 : 0;
}

/** The version folder Codex runs: `local` while present, else the highest version; null when not installed. */
async function activeVersion(base: string): Promise<string | null> {
	const versions = (await readDirEntries(base))
		.filter(entry => entry.isDirectory() && isPathSegment(entry.name))
		.map(entry => entry.name);
	if (versions.includes(LOCAL_VERSION)) return LOCAL_VERSION;
	return versions.sort(compareVersions).at(-1) ?? null;
}

async function readPlugin(
	home: string,
	id: string,
	config: Record<string, unknown>,
	warnings: string[],
): Promise<CodexPlugin | null> {
	const at = id.lastIndexOf("@");
	const name = id.slice(0, at);
	const marketplace = id.slice(at + 1);
	if (at <= 0 || !isPathSegment(name) || !isPathSegment(marketplace)) {
		warnings.push(`[codex-plugins] Ignoring invalid plugin id: ${id}`);
		return null;
	}
	const base = path.join(home, "plugins", "cache", marketplace, name);
	const version = await activeVersion(base);
	// Listed but not installed (or removed since): Codex skips it as well.
	if (version === null) return null;
	const root = path.join(base, version);
	const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
	const raw = await readFile(manifestPath);
	let manifest: unknown = null;
	try {
		manifest = raw === null ? null : JSON.parse(raw);
	} catch {}
	if (!isRecord(manifest)) {
		warnings.push(`[codex-plugins] Missing or invalid plugin.json for ${id}: ${manifestPath}`);
		return null;
	}
	return { id, name, root, manifestPath, manifest, config };
}

/** Installed, enabled Codex plugins outside {@link HOST_PLUGINS}. */
async function listCodexPlugins(ctx: LoadContext): Promise<{ plugins: CodexPlugin[]; warnings: string[] }> {
	const warnings: string[] = [];
	// Codex's home: `CODEX_HOME`, else `~/.codex`.
	const home = $env.CODEX_HOME?.trim() || path.join(ctx.home, ".codex");
	const configPath = path.join(home, "config.toml");
	const raw = await readFile(configPath);
	if (raw === null) return { plugins: [], warnings };
	let toml: unknown;
	try {
		toml = Bun.TOML.parse(raw);
	} catch (error) {
		warnings.push(`[codex-plugins] Invalid TOML in ${configPath}: ${String(error)}`);
		return { plugins: [], warnings };
	}
	const table = isRecord(toml) && isRecord(toml.plugins) ? toml.plugins : {};
	const plugins = await Promise.all(
		Object.entries(table).map(([id, config]) => {
			if (!isRecord(config) || config.enabled === false || HOST_PLUGINS[id] === true) return null;
			return readPlugin(home, id, config, warnings);
		}),
	);
	return { plugins: plugins.filter(plugin => plugin !== null), warnings };
}

/** A manifest path inside the package, or null (with a warning when it points outside). */
function packagePath(plugin: CodexPlugin, value: unknown, key: string, warnings: string[]): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	const resolved = path.resolve(plugin.root, value.trim());
	const relative = path.relative(plugin.root, resolved);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		warnings.push(`[codex-plugins] Ignoring ${key} path outside ${plugin.id}: ${value}`);
		return null;
	}
	return resolved;
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	if (!isUserSourceEnabled(PROVIDER_ID, ctx)) return { items: [] };
	const { plugins, warnings } = await listCodexPlugins(ctx);
	const scans = plugins.flatMap(plugin => {
		const declared = plugin.manifest.skills;
		const entries = declared == null ? ["skills"] : Array.isArray(declared) ? declared : [declared];
		const dirs = new Set<string>();
		for (const entry of entries) {
			const dir = packagePath(plugin, entry, "skills", warnings);
			if (dir !== null) dirs.add(dir);
		}
		return [...dirs].map(dir =>
			scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "user", pluginName: plugin.name }),
		);
	});
	const items: Skill[] = [];
	for (const result of await Promise.all(scans)) {
		items.push(...result.items);
		if (result.warnings) warnings.push(...result.warnings);
	}
	return { items, warnings };
}

/** Why an MCP server runs only inside OpenAI's apps, or undefined when it runs anywhere. */
function hostOnlyReason(server: Record<string, unknown>): string | undefined {
	if (typeof server.command === "string" && path.basename(server.command) === HOST_LAUNCHER) {
		return "it launches OpenAI's Computer Use client";
	}
	if (server.auth === "chatgpt") return "it signs in with Codex's own ChatGPT session";
	return undefined;
}

/** The plugin's server map: the manifest's inline map, its named file, or the package's `.mcp.json`. */
async function readServerMap(
	plugin: CodexPlugin,
	warnings: string[],
): Promise<{ servers: Record<string, unknown>; sourcePath: string } | null> {
	const declared = plugin.manifest.mcpServers;
	let parsed: unknown = declared;
	let sourcePath = plugin.manifestPath;
	if (!isRecord(declared)) {
		const file =
			declared == null ? path.join(plugin.root, ".mcp.json") : packagePath(plugin, declared, "mcpServers", warnings);
		if (file === null) return null;
		const raw = await readFile(file);
		if (raw === null) {
			if (declared != null)
				warnings.push(`[codex-plugins] Missing mcpServers file declared by ${plugin.id}: ${file}`);
			return null;
		}
		try {
			parsed = JSON.parse(raw);
		} catch {
			warnings.push(`[codex-plugins] Invalid JSON in ${file}`);
			return null;
		}
		sourcePath = file;
	}
	if (!isRecord(parsed)) return null;
	// Codex accepts `{ "mcpServers": { ... } }` and the bare server map.
	const servers = "mcpServers" in parsed ? parsed.mcpServers : parsed;
	return isRecord(servers) ? { servers, sourcePath } : null;
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	if (!isUserSourceEnabled(PROVIDER_ID, ctx)) return { items: [] };
	const { plugins, warnings } = await listCodexPlugins(ctx);
	const items: MCPServer[] = [];
	for (const plugin of plugins) {
		const map = await readServerMap(plugin, warnings);
		if (map === null) continue;
		const policies = isRecord(plugin.config.mcp_servers) ? plugin.config.mcp_servers : {};
		for (const [serverName, server] of Object.entries(map.servers)) {
			if (!isRecord(server)) continue;
			const reason = hostOnlyReason(server);
			if (reason !== undefined) {
				logger.debug(`[codex-plugins] Skipping MCP server "${serverName}" of ${plugin.id}: ${reason}`);
				continue;
			}
			// Codex resolves a relative cwd, and a relative command from that cwd, against the package.
			const mapped = extractMCPServersFromToml({ mcp_servers: { [serverName]: server } }, plugin.root)[serverName];
			const policy = policies[serverName];
			items.push({
				name: `${plugin.name}:${serverName}`,
				...mapped,
				// `[plugins."<id>".mcp_servers.<name>] enabled = false` turns the server off in Codex.
				...(isRecord(policy) && policy.enabled === false && { enabled: false }),
				_source: createSourceMeta(PROVIDER_ID, map.sourcePath, "user", undefined, plugin.name),
			});
		}
	}
	return { items, warnings };
}

registerProvider<Skill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from installed, enabled Codex plugins ($CODEX_HOME/plugins/cache)",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from installed, enabled Codex plugins ($CODEX_HOME/plugins/cache)",
	priority: PRIORITY,
	load: loadMCPServers,
});
