/**
 * Installed Codex plugins (SA-CODEX-PLUGINS).
 *
 * Codex lists plugins in `$CODEX_HOME/config.toml` (default `~/.codex`) as
 * `[plugins."<name>@<marketplace>"]`, enabled unless the table, or else `[plugins._default]`,
 * says `enabled = false`, and runs each from the active version of
 * `$CODEX_HOME/plugins/cache/<marketplace>/<name>/<version>/`. Their skills and MCP servers load
 * here under Codex's own rules: its manifest precedence, its MCP field validation, and the
 * environment and header handling it gives a plugin's servers. App references (`.app.json`) do
 * not: a person's ChatGPT apps reach the agent through the ChatGPT sign-in (SA-CHATGPT-APPS).
 * Plugins and servers that run only inside OpenAI's own apps are left out, and so is everything
 * when an organization manages Codex, since its policy cannot be read here.
 */
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { filterChildShellEnv, getPluginsDir, isRecord, logger } from "@oh-my-pi/pi-utils";
import { isUserSourceEnabled, registerProvider } from "../capability";
import { readDirEntries, readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { classifyAgentPluginRoot, parseAgentPluginMcp } from "../discovery/agent-plugin-format";
import { isContainedResolved, realpathIfExists, resolveContainedPath } from "../discovery/contained-path";
import { createSourceMeta, scanSkillsFromDir } from "../discovery/helpers";

const PROVIDER_ID = "codex-plugins";
const DISPLAY_NAME = "Codex Plugins";
/** Below the `codex` provider (70), so a person's own `~/.codex` skills and servers win. */
const PRIORITY = 65;

/** The folder of a plugin Codex links from its source while it is developed; it wins over versions. */
const LOCAL_VERSION = "local";

/**
 * Codex's legacy manifests, in its order of precedence after a root Agent Plugins `plugin.json`.
 * The first one present decides; a link or non-file there stops the search, as in Codex.
 */
const LEGACY_MANIFESTS = [".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"];

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

/**
 * The variables Codex passes a plugin's local stdio server from its own environment, besides
 * those the server names in `env_vars` (codex-rs/rmcp-client `DEFAULT_ENV_VARS`, and
 * `WINDOWS_CORE_ENV_VARS` on Windows), plus the certificate-bundle variables it always keeps
 * (`CUSTOM_CA_ENV_KEYS`). Nothing else, API keys included, reaches the server.
 */
const INHERITED_ENV =
	process.platform === "win32"
		? [
				"PATH",
				"PATHEXT",
				"SHELL",
				"COMSPEC",
				"SYSTEMROOT",
				"WINDIR",
				"SYSTEMDRIVE",
				"USERNAME",
				"USERDOMAIN",
				"USERPROFILE",
				"HOMEDRIVE",
				"HOMEPATH",
				"PROGRAMFILES",
				"PROGRAMFILES(X86)",
				"PROGRAMW6432",
				"PROGRAMDATA",
				"LOCALAPPDATA",
				"APPDATA",
				"TEMP",
				"TMP",
				"TMPDIR",
				"POWERSHELL",
				"PWSH",
			]
		: [
				"HOME",
				"LOGNAME",
				"PATH",
				"SHELL",
				"USER",
				"__CF_USER_TEXT_ENCODING",
				"LANG",
				"LC_ALL",
				"TERM",
				"TMPDIR",
				"TZ",
			];
const CA_BUNDLE_ENV = [
	"CODEX_CA_CERTIFICATE",
	"SSL_CERT_FILE",
	"REQUESTS_CA_BUNDLE",
	"CURL_CA_BUNDLE",
	"NODE_EXTRA_CA_CERTS",
	"GIT_SSL_CAINFO",
	"CARGO_HTTP_CAINFO",
	"PIP_CERT",
	"BUNDLE_SSL_CA_CERT",
	"npm_config_cafile",
	"NPM_CONFIG_CAFILE",
];

/** Fields Codex rejects on a stdio server, and on a streamable HTTP server. */
const NOT_STDIO = [
	"url",
	"bearer_token_env_var",
	"bearer_token",
	"http_headers_helper",
	"http_headers",
	"env_http_headers",
	"oauth",
	"oauth_resource",
	"auth",
];
const NOT_HTTP = ["args", "env", "env_vars", "cwd", "bearer_token"];

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface CodexPlugin {
	/** `<name>@<marketplace>`, the plugin's key in config.toml. */
	id: string;
	name: string;
	marketplace: string;
	/** Skill namespace and MCP server prefix: the name, or `<name>.<marketplace>` when two enabled plugins share it. */
	label: string;
	/** The active version's folder, symlinks resolved; every package path stays inside it. */
	root: string;
	/** `standard`: a root Agent Plugins `plugin.json`, read under that standard; `legacy`: a Codex-style manifest. */
	format: "standard" | "legacy";
	manifestPath: string;
	manifest: Record<string, unknown>;
	/** The plugin's `[plugins."<id>"]` table. */
	config: Record<string, unknown>;
}

interface PluginList {
	plugins: CodexPlugin[];
	warnings: string[];
	/** Scient Agent's launch environment, without a project's `.env` values. */
	env: Record<string, string>;
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
		.filter((entry: Dirent) => entry.isDirectory() && isPathSegment(entry.name))
		.map(entry => entry.name);
	if (versions.includes(LOCAL_VERSION)) return LOCAL_VERSION;
	return versions.sort(compareVersions).at(-1) ?? null;
}

async function lstatOrNull(file: string): Promise<Stats | null> {
	try {
		return await fs.lstat(file);
	} catch {
		return null;
	}
}

/** The first legacy manifest present, read; null (with a warning) when none is usable. */
async function readLegacyManifest(
	root: string,
	id: string,
	warnings: string[],
): Promise<{ manifestPath: string; manifest: Record<string, unknown> } | null> {
	for (const relative of LEGACY_MANIFESTS) {
		const manifestPath = path.join(root, relative);
		const stat = await lstatOrNull(manifestPath);
		if (stat === null) continue;
		if (!stat.isFile()) {
			warnings.push(`[codex-plugins] Ignoring ${id}: ${relative} is not a regular file`);
			return null;
		}
		let manifest: unknown = null;
		try {
			manifest = JSON.parse((await readFile(manifestPath)) ?? "");
		} catch {}
		if (!isRecord(manifest)) {
			warnings.push(`[codex-plugins] Invalid plugin.json for ${id}: ${manifestPath}`);
			return null;
		}
		return { manifestPath, manifest };
	}
	warnings.push(`[codex-plugins] No plugin.json for ${id} in ${root}`);
	return null;
}

async function readPlugin(
	home: string,
	id: string,
	config: Record<string, unknown>,
	warnings: string[],
): Promise<Omit<CodexPlugin, "label"> | null> {
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
	const root = await realpathIfExists(path.join(base, version));
	if (root === null) return null;
	// A root `plugin.json` that targets Agent Plugins wins; one that does not leaves the legacy manifests.
	const rootManifest = path.join(root, "plugin.json");
	const rootStat = await lstatOrNull(rootManifest);
	if (rootStat !== null && !rootStat.isFile()) {
		warnings.push(`[codex-plugins] Ignoring ${id}: plugin.json is not a regular file`);
		return null;
	}
	const standard = await classifyAgentPluginRoot(root);
	if (standard.kind === "invalid") {
		warnings.push(`[codex-plugins] Ignoring ${id}: ${standard.reason}`);
		return null;
	}
	if (standard.kind === "standard") {
		warnings.push(...standard.warnings.map(warning => `[codex-plugins] ${id}: ${warning}`));
		return {
			id,
			name,
			marketplace,
			root,
			format: "standard",
			manifestPath: rootManifest,
			manifest: { ...standard.manifest },
			config,
		};
	}
	const legacy = await readLegacyManifest(root, id, warnings);
	if (legacy === null) return null;
	return { id, name, marketplace, root, format: "legacy", ...legacy, config };
}

async function readToml(file: string, warnings: string[]): Promise<Record<string, unknown> | null> {
	const raw = await readFile(file);
	if (raw === null) return null;
	try {
		const parsed = Bun.TOML.parse(raw);
		return isRecord(parsed) ? parsed : null;
	} catch (error) {
		warnings.push(`[codex-plugins] Invalid TOML in ${file}: ${String(error)}`);
		return null;
	}
}

/**
 * Where an organization's Codex policy lives (requirements, managed config, macOS managed
 * preferences). Codex enforces them over the user's config; Scient Agent cannot, so it loads no
 * plugins while one is present.
 */
function managedPolicyFiles(): string[] {
	if (process.platform === "win32") {
		const programData = process.env.ProgramData || "C:\\ProgramData";
		return [path.join(programData, "OpenAI", "Codex", "requirements.toml")];
	}
	const files = ["/etc/codex/requirements.toml", "/etc/codex/managed_config.toml"];
	if (process.platform === "darwin") {
		const managed = "/Library/Managed Preferences";
		files.push(
			path.join(managed, "com.openai.codex.plist"),
			path.join(managed, os.userInfo().username, "com.openai.codex.plist"),
		);
	}
	return files;
}

/** Installed, enabled Codex plugins outside {@link HOST_PLUGINS}. */
async function listCodexPlugins(ctx: LoadContext): Promise<PluginList> {
	const warnings: string[] = [];
	// The environment Scient Agent was launched with: a project's `.env` never chooses Codex's
	// home or the credentials sent to a plugin's server.
	const env = filterChildShellEnv(Bun.env);
	for (const file of managedPolicyFiles()) {
		if ((await lstatOrNull(file)) === null) continue;
		warnings.push(
			`[codex-plugins] Codex is managed by an organization policy (${file}), which Scient Agent cannot apply; no Codex plugins load`,
		);
		return { plugins: [], warnings, env };
	}
	// Codex's home: `CODEX_HOME`, else `~/.codex`.
	const home = env.CODEX_HOME?.trim() || path.join(ctx.home, ".codex");
	const user = await readToml(path.join(home, "config.toml"), warnings);
	if (user === null) return { plugins: [], warnings, env };
	// The system layer sits under the user's; per-plugin tables and `_default` merge by key.
	const system = process.platform === "win32" ? null : await readToml("/etc/codex/config.toml", warnings);
	const table: Record<string, unknown> = {
		...(isRecord(system?.plugins) ? system.plugins : {}),
		...(isRecord(user.plugins) ? user.plugins : {}),
	};
	const defaults = isRecord(table._default) ? table._default : {};
	const enabledByDefault = defaults.enabled !== false;
	const read = await Promise.all(
		Object.entries(table).map(([id, config]) => {
			if (id === "_default" || !isRecord(config) || HOST_PLUGINS[id] === true) return null;
			const enabled = typeof config.enabled === "boolean" ? config.enabled : enabledByDefault;
			return enabled ? readPlugin(home, id, config, warnings) : null;
		}),
	);
	const found = read.filter(plugin => plugin !== null);
	const sharedNames = new Set(
		found.filter((plugin, index) => found.findIndex(other => other.name === plugin.name) !== index).map(p => p.name),
	);
	const plugins = found.map(plugin => ({
		...plugin,
		label: sharedNames.has(plugin.name) ? `${plugin.name}.${plugin.marketplace}` : plugin.name,
	}));
	return { plugins, warnings, env };
}

/** A manifest path inside the package, symlinks resolved; null (with a warning when it points outside). */
async function packagePath(plugin: CodexPlugin, value: unknown, key: string, warnings: string[]) {
	if (typeof value !== "string" || !value.trim()) return null;
	const resolved = await resolveContainedPath(plugin.root, path.resolve(plugin.root, value.trim()));
	if (resolved.status === "outside") {
		warnings.push(`[codex-plugins] Ignoring ${key} path outside ${plugin.id}: ${value}`);
		return null;
	}
	return resolved.status === "ok" ? resolved.realPath : null;
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	if (!isUserSourceEnabled(PROVIDER_ID, ctx)) return { items: [] };
	const { plugins, warnings } = await listCodexPlugins(ctx);
	const dirsByPlugin = await Promise.all(
		plugins.map(async plugin => {
			const declared = plugin.format === "standard" ? undefined : plugin.manifest.skills;
			const entries = declared == null ? ["skills"] : Array.isArray(declared) ? declared : [declared];
			const dirs = new Set<string>();
			for (const entry of entries) {
				const dir = await packagePath(plugin, entry, "skills", warnings);
				if (dir !== null) dirs.add(dir);
			}
			return { plugin, dirs: [...dirs] };
		}),
	);
	const scans = dirsByPlugin.flatMap(({ plugin, dirs }) =>
		dirs.map(dir =>
			scanSkillsFromDir(ctx, { dir, providerId: PROVIDER_ID, level: "user", pluginName: plugin.label }),
		),
	);
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

/**
 * The Codex key that narrows a server's tools, or undefined when it exposes them all. Scient
 * Agent's MCP servers carry no tool filter, so such a server would run with more tools than Codex
 * allows. An empty denylist narrows nothing.
 */
function toolFilterKey(table: Record<string, unknown>): string | undefined {
	if (table.enabled_tools != null) return "enabled_tools";
	const denied = table.disabled_tools;
	if (denied != null && !(Array.isArray(denied) && denied.length === 0)) return "disabled_tools";
	return undefined;
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(item => typeof item === "string");
const isStringMap = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every(item => typeof item === "string");

/** Codex's `env_vars` entry: a name, or `{ name, source = "local" }`. */
function envVarName(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (isRecord(entry) && typeof entry.name === "string" && (entry.source ?? "local") === "local") return entry.name;
	return undefined;
}

type Mapped = { server: Partial<MCPServer> } | { error: string };

/**
 * A legacy plugin's server as Codex reads it: exactly one transport with its own fields, package
 * paths kept inside the package, values taken literally, and only Codex's variables inherited.
 */
async function mapLegacyServer(
	plugin: CodexPlugin,
	server: Record<string, unknown>,
	env: Record<string, string>,
): Promise<Mapped> {
	const isStdio = typeof server.command === "string";
	if (!isStdio && typeof server.url !== "string") return { error: "it declares neither command nor url" };
	const wrong = (isStdio ? NOT_STDIO : NOT_HTTP).find(key => server[key] != null);
	if (wrong !== undefined) return { error: `${wrong} is not supported for ${isStdio ? "stdio" : "streamable HTTP"}` };
	const timeout =
		typeof server.tool_timeout_sec === "number" && server.tool_timeout_sec > 0
			? { timeout: server.tool_timeout_sec * 1000 }
			: {};

	if (isStdio) {
		const command = (server.command as string).trim();
		if (!command) return { error: "command is empty" };
		if (server.args != null && !isStringList(server.args)) return { error: "invalid args" };
		if (server.env != null && !isStringMap(server.env)) return { error: "invalid env" };
		if (server.env_vars != null && !Array.isArray(server.env_vars)) return { error: "invalid env_vars" };
		const forwarded = ((server.env_vars as unknown[] | undefined) ?? []).map(envVarName);
		if (forwarded.some(name => name === undefined)) return { error: "invalid env_vars" };
		// Codex runs a server from the package unless it names a folder inside it.
		const cwd = typeof server.cwd === "string" ? path.resolve(plugin.root, server.cwd) : plugin.root;
		if (!(await isContainedResolved(plugin.root, cwd))) return { error: `cwd ${server.cwd} leaves the package` };
		// A bare name runs from PATH and an absolute path as given; a relative path runs from the package.
		const relative = !path.isAbsolute(command) && /[\\/]/.test(command);
		const resolvedCommand = relative ? path.resolve(cwd, command) : command;
		if (relative && !(await isContainedResolved(plugin.root, resolvedCommand))) {
			return { error: `command ${command} leaves the package` };
		}
		return {
			server: {
				transport: "stdio",
				command: resolvedCommand,
				...(server.args != null && { args: server.args as string[] }),
				...(server.env != null && { env: server.env as Record<string, string> }),
				envPolicy: "literal",
				envInherit: [...new Set([...INHERITED_ENV, ...CA_BUNDLE_ENV, ...(forwarded as string[])])],
				cwd,
				...timeout,
			},
		};
	}

	if (server.http_headers_helper != null) return { error: "it computes its headers with a helper command" };
	if (server.auth != null && server.auth !== "oauth") return { error: `auth ${String(server.auth)} is not supported` };
	if (server.http_headers != null && !isStringMap(server.http_headers)) return { error: "invalid http_headers" };
	if (server.env_http_headers != null && !isStringMap(server.env_http_headers)) {
		return { error: "invalid env_http_headers" };
	}
	if (server.bearer_token_env_var != null && typeof server.bearer_token_env_var !== "string") {
		return { error: "invalid bearer_token_env_var" };
	}
	if (server.oauth != null && !isRecord(server.oauth)) return { error: "invalid oauth" };
	const url = server.url as string;
	if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return { error: `invalid url ${url}` };
	// Static headers are data; the others name variables of the launch environment, as in Codex.
	const headers: Record<string, string> = { ...(server.http_headers as Record<string, string> | undefined) };
	for (const [header, name] of Object.entries((server.env_http_headers ?? {}) as Record<string, string>)) {
		const value = env[name]?.trim();
		if (value) headers[header] = value;
	}
	const bearer = server.bearer_token_env_var ? env[server.bearer_token_env_var as string]?.trim() : undefined;
	if (bearer) headers.Authorization = `Bearer ${bearer}`;
	// Codex's OAuth client settings, snake_case or the camelCase plugins may use.
	const oauthTable = (server.oauth ?? {}) as Record<string, unknown>;
	const oauth: NonNullable<MCPServer["oauth"]> = {};
	for (const [snake, camel, target] of [
		["client_id", "clientId", "clientId"],
		["client_secret", "clientSecret", "clientSecret"],
		["callback_url", "callbackUrl", "redirectUri"],
	] as const) {
		const value = oauthTable[snake] ?? oauthTable[camel];
		if (typeof value === "string" && value) oauth[target] = value;
	}
	const port = oauthTable.callback_port ?? oauthTable.callbackPort;
	if (Number.isInteger(port) && Number(port) > 0) oauth.callbackPort = Number(port);
	if (isStringList(server.scopes) && server.scopes.length > 0) oauth.scope = server.scopes.join(" ");
	const resource = typeof server.oauth_resource === "string" && server.oauth_resource ? server.oauth_resource : null;
	return {
		server: {
			transport: "http",
			url,
			...(Object.keys(headers).length > 0 && { headers }),
			headerPolicy: "origin-locked",
			...(Object.keys(oauth).length > 0 && { oauth }),
			...(resource !== null && { auth: { type: "oauth" as const, resource } }),
			...timeout,
		},
	};
}

/** The plugin's server map: the manifest's inline map, its named file, or the package's `.mcp.json`. */
async function readLegacyServerMap(
	plugin: CodexPlugin,
	warnings: string[],
): Promise<{ servers: Record<string, unknown>; sourcePath: string } | null> {
	const declared = plugin.manifest.mcpServers;
	let parsed: unknown = declared;
	let sourcePath = plugin.manifestPath;
	if (!isRecord(declared)) {
		const file = await packagePath(plugin, declared ?? ".mcp.json", "mcpServers", warnings);
		if (file === null) {
			if (declared != null) warnings.push(`[codex-plugins] Missing mcpServers file declared by ${plugin.id}`);
			return null;
		}
		try {
			parsed = JSON.parse((await readFile(file)) ?? "");
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

/** An Agent Plugins package's `mcp.json`, read under that standard, keyed by server name. */
async function readStandardServers(
	ctx: LoadContext,
	plugin: CodexPlugin,
	warnings: string[],
): Promise<{ servers: Record<string, Partial<MCPServer>>; sourcePath: string } | null> {
	const resolved = await resolveContainedPath(plugin.root, path.join(plugin.root, "mcp.json"));
	if (resolved.status !== "ok") {
		if (resolved.status === "outside") warnings.push(`[codex-plugins] ${plugin.id}: mcp.json leaves the package`);
		return null;
	}
	const raw = await readFile(resolved.realPath);
	if (raw === null) return null;
	const digest = new Bun.CryptoHasher("sha256").update(`codex:${plugin.id}`).digest("hex").slice(0, 16);
	const pluginData = path.join(getPluginsDir(ctx.home), "data", `codex-${plugin.name}-${digest}`);
	const result = await parseAgentPluginMcp(raw, { pluginRoot: plugin.root, pluginData });
	if (result.status === "disabled") {
		warnings.push(`[codex-plugins] ${plugin.id}: MCP disabled: ${result.reason}`);
		return null;
	}
	warnings.push(...result.warnings.map(warning => `[codex-plugins] ${plugin.id}: ${warning}`));
	if (result.servers.some(server => server.transport === "stdio")) await fs.mkdir(pluginData, { recursive: true });
	const servers: Record<string, Partial<MCPServer>> = {};
	for (const { name, ...server } of result.servers) {
		servers[name] =
			server.transport === "stdio"
				? { ...server, envPolicy: "literal", envInherit: [...INHERITED_ENV, ...CA_BUNDLE_ENV] }
				: { ...server, headerPolicy: "origin-locked" };
	}
	return { servers, sourcePath: resolved.realPath };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	if (!isUserSourceEnabled(PROVIDER_ID, ctx)) return { items: [] };
	const { plugins, warnings, env } = await listCodexPlugins(ctx);
	const items: MCPServer[] = [];
	for (const plugin of plugins) {
		const policies = isRecord(plugin.config.mcp_servers) ? plugin.config.mcp_servers : {};
		const standard = plugin.format === "standard" ? await readStandardServers(ctx, plugin, warnings) : null;
		const legacy = plugin.format === "legacy" ? await readLegacyServerMap(plugin, warnings) : null;
		const declared: Record<string, unknown> = standard?.servers ?? legacy?.servers ?? {};
		const sourcePath = standard?.sourcePath ?? legacy?.sourcePath ?? plugin.manifestPath;
		for (const [serverName, server] of Object.entries(declared)) {
			if (!isRecord(server)) continue;
			const skip = `[codex-plugins] Skipping MCP server "${serverName}" of ${plugin.id}`;
			const reason = hostOnlyReason(server);
			if (reason !== undefined) {
				logger.debug(`${skip}: ${reason}`);
				continue;
			}
			const declaredPolicy = policies[serverName];
			const policy: Record<string, unknown> = isRecord(declaredPolicy) ? declaredPolicy : {};
			const filter = toolFilterKey(server) ?? toolFilterKey(policy);
			if (filter !== undefined) {
				warnings.push(`${skip}: Codex restricts its tools (${filter}), which Scient Agent cannot enforce`);
				continue;
			}
			let mapped: Mapped;
			try {
				mapped = standard !== null ? { server } : await mapLegacyServer(plugin, server, env);
			} catch (error) {
				mapped = { error: String(error) };
			}
			if ("error" in mapped) {
				warnings.push(`${skip}: ${mapped.error} (${sourcePath})`);
				continue;
			}
			items.push({
				name: `${plugin.label}:${serverName}`,
				...mapped.server,
				// `[plugins."<id>".mcp_servers.<name>] enabled = false` turns the server off in Codex.
				...(policy.enabled === false && { enabled: false }),
				_source: createSourceMeta(PROVIDER_ID, sourcePath, "user", undefined, plugin.label),
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
