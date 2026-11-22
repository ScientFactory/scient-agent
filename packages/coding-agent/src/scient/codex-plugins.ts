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
 * Plugins and servers that run only inside OpenAI's own apps are left out, and so are servers
 * whose tools Codex narrows or asks about. Nothing loads when an organization manages Codex, since
 * its policy cannot be applied here, or when this run cannot tell its launch environment apart.
 */
import type { Dirent, Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { filterProcessEnv, getLaunchEnv, getPluginsDir, isRecord, logger, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { isUserSourceEnabled, registerProvider } from "../capability";
import { readDirEntries, readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type Skill, type SkillFrontmatter, skillCapability } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { classifyAgentPluginRoot, parseAgentPluginMcp } from "../discovery/agent-plugin-format";
import { isContainedResolved, realpathIfExists, resolveContainedPath } from "../discovery/contained-path";
import { compareSkillOrder, createSourceMeta } from "../discovery/helpers";

const PROVIDER_ID = "codex-plugins";
const DISPLAY_NAME = "Codex Plugins";
/** Below the `codex` provider (70), so a person's own `~/.codex` skills and servers win. */
const PRIORITY = 65;

/** The folder of a plugin Codex links from its source while it is developed; it wins over versions. */
const LOCAL_VERSION = "local";

/**
 * Codex's legacy manifests, in its order of precedence after a root Agent Plugins `plugin.json`.
 * The first one present decides; a link or non-file there, or a linked folder holding it, stops
 * the search, as in Codex.
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

const IS_WINDOWS = process.platform === "win32";

/**
 * The variables Codex passes a plugin's local stdio server from its own environment, besides
 * those the server names in `env_vars` (codex-rs/rmcp-client `DEFAULT_ENV_VARS`, and
 * `WINDOWS_CORE_ENV_VARS` on Windows). Nothing else, API keys included, reaches the server.
 */
const INHERITED_ENV = IS_WINDOWS
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
	: ["HOME", "LOGNAME", "PATH", "SHELL", "USER", "__CF_USER_TEXT_ENCODING", "LANG", "LC_ALL", "TERM", "TMPDIR", "TZ"];
/** Certificate bundles Codex always passes on, as absolute paths (`CUSTOM_CA_ENV_KEYS`). */
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
/**
 * Names Codex never lets a model-reachable process have (`NON_INHERITABLE_ENV_VARS`), even from
 * `env`, compared without case on every platform, as Codex compares them.
 */
const NON_INHERITABLE_ENV = [
	"CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
	"NODE_REPL_AUTH_TOKEN",
	"CODEX_GUARDIAN_DECISIONS_API_KEY",
	"OPENAI_FEDERATION_RULE_ID",
	"OPENAI_IDENTITY_TOKEN_FILE",
	"OPENAI_IDENTITY_TOKEN_SOURCE",
	"OPENAI_SPIFFE_AUDIENCE",
	"OPENAI_SPIFFE_ID",
	"OPENAI_WORKLOAD_IDENTITY_CONTEXT",
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

/** Codex's skill scan limits for a plugin's skill folder (codex-rs/ext/skills loader). */
const MAX_SKILL_SCAN_DEPTH = 6;
const MAX_SKILL_DIRS = 2000;

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface CodexPlugin {
	/** `<name>@<marketplace>`, the plugin's key in config.toml. */
	id: string;
	name: string;
	marketplace: string;
	/**
	 * Skill namespace and MCP server prefix: the name, or `<name>:<marketplace>` when two enabled
	 * plugins share it. Neither part may contain `:`, so the qualified form never meets another.
	 */
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

/** A user `[[skills.config]]` entry Codex applies to loaded skills, its path canonical. */
interface SkillRule {
	selector: { path: string } | { name: string };
	enabled: boolean;
}

interface PluginList {
	plugins: CodexPlugin[];
	warnings: string[];
	/** Scient Agent's launch environment, without any `.env` file's values. */
	env: Record<string, string>;
	/** The user config's skill rules, in Codex's order. */
	skillRules: SkillRule[];
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

/** Environment names compare case-insensitively on Windows, as Codex compares them there. */
function sameEnvName(left: string, right: string): boolean {
	return IS_WINDOWS ? left.toUpperCase() === right.toUpperCase() : left === right;
}

function envValue(env: Record<string, string>, name: string): string | undefined {
	if (!IS_WINDOWS) return env[name];
	const key = Object.keys(env).find(candidate => sameEnvName(candidate, name));
	return key === undefined ? undefined : env[key];
}

/**
 * The environment Codex gives a plugin's local stdio server: its variable list and the server's
 * `env_vars` from the launch environment, certificate bundles as absolute paths, then the
 * server's own `env`, never the names Codex withholds. The server inherits nothing else.
 */
function stdioEnv(
	env: Record<string, string>,
	forwarded: readonly string[],
	declared: Record<string, string> | undefined,
): Record<string, string> {
	const result: Record<string, string> = {};
	const put = (name: string, value: string) => {
		for (const key of Object.keys(result)) if (sameEnvName(key, name)) delete result[key];
		result[name] = value;
	};
	for (const name of [...INHERITED_ENV, ...forwarded]) {
		const value = envValue(env, name);
		if (value !== undefined) put(name, value);
	}
	for (const name of CA_BUNDLE_ENV) {
		const value = envValue(env, name);
		if (value) put(name, path.resolve(value));
	}
	for (const [name, value] of Object.entries(declared ?? {})) put(name, value);
	for (const key of Object.keys(result)) {
		if (NON_INHERITABLE_ENV.some(name => name.toUpperCase() === key.toUpperCase())) delete result[key];
	}
	return result;
}

/** The first legacy manifest present, read; null (with a warning) when none is usable. */
async function readLegacyManifest(
	root: string,
	id: string,
	warnings: string[],
	manifests: readonly string[] = LEGACY_MANIFESTS,
): Promise<{ manifestPath: string; manifest: Record<string, unknown> } | null> {
	for (const relative of manifests) {
		const manifestPath = path.join(root, relative);
		const folder = await lstatOrNull(path.dirname(manifestPath));
		if (folder === null) continue;
		if (!folder.isDirectory()) {
			warnings.push(`[codex-plugins] Ignoring ${id}: ${path.dirname(relative)} is not a folder`);
			return null;
		}
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
		const mistyped = isRecord(manifest) ? manifestTypeError(manifest) : "the file";
		if (mistyped !== undefined || !isRecord(manifest)) {
			warnings.push(`[codex-plugins] Invalid plugin.json for ${id} (${mistyped}): ${manifestPath}`);
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

/** Codex's layer merge: tables merge key by key at every depth, and the higher layer's other values win. */
function mergeLayers(lower: Record<string, unknown>, higher: Record<string, unknown>): Record<string, unknown> {
	const merged: Record<string, unknown> = { ...lower };
	for (const [key, value] of Object.entries(higher)) {
		const below = merged[key];
		merged[key] = isRecord(below) && isRecord(value) ? mergeLayers(below, value) : value;
	}
	return merged;
}

interface WindowsPolicyProbe {
	/** The ProgramData known folder. */
	programData: string;
	/** The Group Policy `RequirementsPath` value, when set. */
	requirementsPath: string | null;
}

let windowsProbe: WindowsPolicyProbe | null | undefined;

/**
 * What Codex reads from Windows itself to find its policy: the ProgramData known folder (not the
 * `ProgramData` variable anyone can set) and the 64-bit `HKLM\SOFTWARE\Policies\OpenAI\Codex`
 * `RequirementsPath`, through .NET's calls to the same system APIs; null when they cannot be read.
 */
function probeWindowsPolicy(): WindowsPolicyProbe | null {
	if (windowsProbe !== undefined) return windowsProbe;
	// Any error stops the script with no output, so only a lookup that succeeded reports no policy.
	const script = [
		"$ErrorActionPreference = 'Stop'",
		"try { $key = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64').OpenSubKey('SOFTWARE\\Policies\\OpenAI\\Codex')",
		"$path = if ($key) { $key.GetValue('RequirementsPath') } else { $null }",
		"$data = [Environment]::GetFolderPath('CommonApplicationData')",
		"[Console]::Out.Write((@{ ok = $true; programData = $data; requirementsPath = $path } | ConvertTo-Json -Compress)) } catch { exit 1 }",
	].join("; ");
	let probe: unknown = null;
	try {
		const query = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], {
			stdout: "pipe",
			stderr: "ignore",
		});
		probe = query.exitCode === 0 ? JSON.parse(query.stdout.toString()) : null;
	} catch {}
	windowsProbe =
		isRecord(probe) &&
		probe.ok === true &&
		typeof probe.programData === "string" &&
		path.win32.isAbsolute(probe.programData) &&
		(probe.requirementsPath == null || typeof probe.requirementsPath === "string")
			? { programData: probe.programData, requirementsPath: (probe.requirementsPath as string | null) ?? null }
			: null;
	return windowsProbe;
}

/** Codex's system folder: `/etc/codex`, or `OpenAI\Codex` in the ProgramData known folder on Windows. */
function systemDir(): string {
	if (!IS_WINDOWS) return "/etc/codex";
	return path.join(probeWindowsPolicy()?.programData ?? "C:\\ProgramData", "OpenAI", "Codex");
}

/**
 * Why Codex may be under an organization policy Scient Agent cannot apply (requirements, a
 * managed config, macOS managed preferences, or a Windows Group Policy requirements path), or
 * undefined when none is present. A policy location that cannot be checked counts as present,
 * as Codex refuses to assume it absent.
 */
async function managedPolicy(): Promise<string | undefined> {
	const files = [path.join(systemDir(), "requirements.toml")];
	if (IS_WINDOWS) {
		const probe = probeWindowsPolicy();
		if (probe === null) return "Windows cannot say where Codex's organization policy is";
		if (probe.requirementsPath !== null) {
			return `Codex is managed by an organization policy (Group Policy RequirementsPath ${probe.requirementsPath})`;
		}
	} else {
		// Codex ignores a leftover managed_config.toml on Windows.
		files.push("/etc/codex/managed_config.toml");
	}
	if (process.platform === "darwin") {
		const managed = "/Library/Managed Preferences";
		files.push(
			path.join(managed, "com.openai.codex.plist"),
			path.join(managed, os.userInfo().username, "com.openai.codex.plist"),
		);
	}
	for (const file of files) {
		try {
			await fs.stat(file);
			return `Codex is managed by an organization policy (${file})`;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") return `Codex's organization policy at ${file} cannot be checked (${code})`;
		}
	}
	return undefined;
}

/**
 * The user config's `[[skills.config]]` rules as Codex reads them: an entry selects by an absolute
 * `path` (canonicalized) or a `name`, never both; a later entry for the same selector replaces an
 * earlier one. A `skills` table Codex cannot read yields no rules, as in Codex.
 */
async function readSkillRules(user: Record<string, unknown>, warnings: string[]): Promise<SkillRule[]> {
	const skills = user.skills;
	if (skills == null) return [];
	const entries = isRecord(skills) ? (skills.config ?? []) : null;
	const valid =
		isRecord(skills) &&
		Array.isArray(entries) &&
		entries.every(
			entry =>
				isRecord(entry) &&
				isBoolean(entry.enabled) &&
				(entry.path == null || (isString(entry.path) && path.isAbsolute(entry.path))) &&
				(entry.name == null || isString(entry.name)),
		) &&
		(skills.bundled == null ||
			(isRecord(skills.bundled) && (skills.bundled.enabled == null || isBoolean(skills.bundled.enabled)))) &&
		(skills.include_instructions == null || isBoolean(skills.include_instructions)) &&
		(skills.max_context_tokens == null || isPositiveInteger(skills.max_context_tokens));
	if (!valid) {
		warnings.push("[codex-plugins] Ignoring Codex's [skills] settings, which Codex cannot read either");
		return [];
	}
	const rules: SkillRule[] = [];
	for (const entry of entries as Record<string, unknown>[]) {
		const name = typeof entry.name === "string" ? entry.name.trim() : undefined;
		if ((entry.path == null) === (entry.name == null) || name === "") continue;
		const selector =
			name !== undefined
				? { name }
				: { path: await fs.realpath(entry.path as string).catch(() => entry.path as string) };
		const replaced = rules.findIndex(rule => JSON.stringify(rule.selector) === JSON.stringify(selector));
		if (replaced !== -1) rules.splice(replaced, 1);
		rules.push({ selector, enabled: entry.enabled as boolean });
	}
	return rules;
}

/**
 * The first field of the merged `[plugins]` table whose type Codex rejects (`PluginsConfigToml`),
 * or undefined. Codex then reads no plugin settings at all.
 */
function pluginsTypeError(table: Record<string, unknown>): string | undefined {
	for (const [id, config] of Object.entries(table)) {
		if (!isRecord(config)) return id;
		if (config.enabled != null && !isBoolean(config.enabled)) return `${id}.enabled`;
		for (const key of ["remote_plugin_id", "release_id"]) {
			if (config[key] != null && !isString(config[key])) return `${id}.${key}`;
		}
		if (config.apps != null && !isRecord(config.apps)) return `${id}.apps`;
		const servers = config.mcp_servers;
		if (servers == null) continue;
		if (!isRecord(servers)) return `${id}.mcp_servers`;
		for (const [name, policy] of Object.entries(servers)) {
			const at = `${id}.mcp_servers.${name}`;
			if (!isRecord(policy)) return at;
			if (policy.enabled != null && !isBoolean(policy.enabled)) return `${at}.enabled`;
			const mode = policy.default_tools_approval_mode;
			if (mode != null && !isApprovalMode(mode)) return `${at}.default_tools_approval_mode`;
			for (const key of ["enabled_tools", "disabled_tools"]) {
				if (policy[key] != null && !isStringList(policy[key])) return `${at}.${key}`;
			}
			if (policy.tools != null && !SERVER_FIELD_TYPES.tools(policy.tools)) return `${at}.tools`;
		}
	}
	return undefined;
}

/** Installed, enabled Codex plugins outside {@link HOST_PLUGINS}. */
async function listCodexPlugins(ctx: LoadContext): Promise<PluginList> {
	const warnings: string[] = [];
	// The environment Scient Agent was launched with: no `.env` file, from this project or one the
	// agent worked in before, chooses Codex's home or what reaches a plugin's server.
	const launch = getLaunchEnv();
	if (launch === undefined) {
		warnings.push(
			"[codex-plugins] This run cannot tell Scient Agent's launch environment from .env files (start it with --no-env-file); no Codex plugins load",
		);
		return { plugins: [], warnings, env: {}, skillRules: [] };
	}
	const env = filterProcessEnv(launch);
	// Codex's home: `CODEX_HOME`, else `~/.codex`.
	const home = env.CODEX_HOME?.trim() || path.join(ctx.home, ".codex");
	const policy = await managedPolicy();
	if (policy !== undefined) {
		warnings.push(`[codex-plugins] ${policy}, which Scient Agent cannot apply; no Codex plugins load`);
		return { plugins: [], warnings, env, skillRules: [] };
	}
	const user = await readToml(path.join(home, "config.toml"), warnings);
	if (user === null) return { plugins: [], warnings, env, skillRules: [] };
	const system = await readToml(path.join(systemDir(), "config.toml"), warnings);
	const merged = mergeLayers(system ?? {}, user);
	const table = isRecord(merged.plugins) ? merged.plugins : {};
	// Codex reads no plugin at all from a [plugins] table it cannot read.
	const mistyped = pluginsTypeError(table);
	if (mistyped !== undefined) {
		warnings.push(`[codex-plugins] Codex cannot read its [plugins] settings (${mistyped}); no Codex plugins load`);
		return { plugins: [], warnings, env, skillRules: [] };
	}
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
	const shared = new Set(
		found.filter((plugin, index) => found.findIndex(other => other.name === plugin.name) !== index).map(p => p.name),
	);
	const plugins = found.map(plugin => ({
		...plugin,
		label: shared.has(plugin.name) ? `${plugin.name}:${plugin.marketplace}` : plugin.name,
	}));
	return { plugins, warnings, env, skillRules: await readSkillRules(user, warnings) };
}

/**
 * A manifest path's part below `./`, or null when Codex ignores the path: not `./`-relative,
 * rooted, or holding `..`. A backslash separates path parts only on Windows, as in Codex.
 */
function manifestRelative(value: unknown): string | null {
	if (typeof value !== "string" || !value.startsWith("./")) return null;
	const relative = value.slice(2);
	if (!relative || relative.startsWith("/")) return null;
	if (IS_WINDOWS && (relative.startsWith("\\") || /^[A-Za-z]:/.test(relative))) return null;
	return relative.split(IS_WINDOWS ? /[\\/]/ : "/").includes("..") ? null : relative;
}

/** A manifest path Codex takes, symlinks resolved; null (with a warning when it resolves outside the package). */
async function packagePath(plugin: CodexPlugin, relative: string, key: string, warnings: string[]) {
	const resolved = await resolveContainedPath(plugin.root, path.resolve(plugin.root, relative));
	if (resolved.status === "outside") {
		warnings.push(`[codex-plugins] Ignoring ${key} path outside ${plugin.id}: ./${relative}`);
		return null;
	}
	return resolved.status === "ok" ? resolved.realPath : null;
}

/** A plugin's skill, read once its `SKILL.md` is known to stay inside the package; null when it is not a skill. */
async function readPluginSkill(
	plugin: CodexPlugin,
	skillPath: string,
	realPath: string,
	warnings: string[],
): Promise<Skill | null> {
	const stat = await fs.stat(realPath).catch(() => null);
	if (!stat?.isFile()) return null;
	const content = await readFile(realPath);
	if (!content) return null;
	try {
		const { frontmatter, body } = parseFrontmatter(content, { source: skillPath });
		if (frontmatter.enabled === false) return null;
		const folder = path.basename(path.dirname(skillPath));
		const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() || folder : folder;
		// `/` is reserved for skill namespaces and skill:// paths.
		if (/[\\/]/.test(name)) {
			warnings.push(`[codex-plugins] Skill name "${name}" contains a path separator, skipping: ${skillPath}`);
			return null;
		}
		return {
			name,
			path: skillPath,
			content: body,
			frontmatter: frontmatter as SkillFrontmatter,
			level: "user",
			// skill:// resolves every file of the skill inside the package too.
			containRoot: plugin.root,
			_source: createSourceMeta(PROVIDER_ID, skillPath, "user", undefined, plugin.label),
		};
	} catch {
		warnings.push(`[codex-plugins] Failed to read skill file: ${skillPath}`);
		return null;
	}
}

/**
 * Codex's scan of a plugin's skill folder: every `SKILL.md` down to its depth limit for a legacy
 * plugin, each direct child's for an Agent Plugins package, hidden folders skipped. Each folder and
 * `SKILL.md` must resolve inside the package before it is read.
 */
async function scanPluginSkills(plugin: CodexPlugin, dir: string, warnings: string[]): Promise<Skill[]> {
	const recursive = plugin.format === "legacy";
	// A SKILL.md sits one level below its folder, so folders go one level less deep than files.
	const maxFolderDepth = recursive ? MAX_SKILL_SCAN_DEPTH - 1 : 1;
	const skills: Skill[] = [];
	const seen = new Set<string>();
	const visit = async (folder: string, depth: number): Promise<void> => {
		if (seen.has(folder) || seen.size >= MAX_SKILL_DIRS) return;
		seen.add(folder);
		if (recursive || depth === 1) {
			const skillPath = path.join(folder, "SKILL.md");
			const file = await resolveContainedPath(plugin.root, skillPath);
			if (file.status === "outside")
				warnings.push(`[codex-plugins] Ignoring skill outside ${plugin.id}: ${skillPath}`);
			if (file.status === "ok") {
				const skill = await readPluginSkill(plugin, skillPath, file.realPath, warnings);
				if (skill !== null) skills.push(skill);
			}
		}
		if (depth >= maxFolderDepth) return;
		const children = (await readDirEntries(folder)).filter(
			entry => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()),
		);
		await Promise.all(
			children.map(async entry => {
				const child = await resolveContainedPath(plugin.root, path.join(folder, entry.name));
				if (child.status === "outside") {
					warnings.push(
						`[codex-plugins] Ignoring skill folder outside ${plugin.id}: ${path.join(folder, entry.name)}`,
					);
				}
				if (child.status !== "ok") return;
				if ((await fs.stat(child.realPath).catch(() => null))?.isDirectory())
					await visit(child.realPath, depth + 1);
			}),
		);
	};
	await visit(dir, 0);
	return skills;
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<Skill>> {
	if (!isUserSourceEnabled(PROVIDER_ID, ctx)) return { items: [] };
	const { plugins, warnings, skillRules } = await listCodexPlugins(ctx);
	// Each skill with the namespace Codex gives it: its plugin manifest's name.
	const found: { skill: Skill; namespace: string }[] = [];
	await Promise.all(
		plugins.map(async plugin => {
			const declared = plugin.format === "standard" ? undefined : plugin.manifest.skills;
			const listed = declared == null ? [] : Array.isArray(declared) ? declared : [declared];
			// Codex drops the paths it does not take, and falls back to `skills/` when none is left.
			const taken = listed.map(manifestRelative).filter(relative => relative !== null);
			if (taken.length < listed.length) {
				warnings.push(`[codex-plugins] Ignoring skills paths of ${plugin.id} that are not ./paths without ..`);
			}
			const dirs = new Set<string>();
			for (const relative of taken.length > 0 ? taken : ["skills"]) {
				const dir = await packagePath(plugin, relative, "skills", warnings);
				if (dir !== null) dirs.add(dir);
			}
			const namespace =
				typeof plugin.manifest.name === "string" && plugin.manifest.name ? plugin.manifest.name : plugin.name;
			for (const dir of dirs) {
				for (const skill of await scanPluginSkills(plugin, dir, warnings)) found.push({ skill, namespace });
			}
		}),
	);
	// The user's [[skills.config]] rules, in order: a path selects one SKILL.md, a name every skill
	// so named (bare, or as Codex names plugin skills, `<manifest name>:<skill>`).
	const realPaths = await Promise.all(found.map(({ skill }) => fs.realpath(skill.path).catch(() => skill.path)));
	const disabled = new Set<string>();
	for (const rule of skillRules) {
		found.forEach(({ skill, namespace }, index) => {
			const selected =
				"path" in rule.selector
					? rule.selector.path === realPaths[index]
					: rule.selector.name === skill.name || rule.selector.name === `${namespace}:${skill.name}`;
			if (!selected) return;
			if (rule.enabled) disabled.delete(realPaths[index]);
			else disabled.add(realPaths[index]);
		});
	}
	const items = found.filter((_, index) => !disabled.has(realPaths[index])).map(({ skill }) => skill);
	// Reads finish in any order; the list does not.
	items.sort((a, b) => compareSkillOrder(a.name, a.path, b.name, b.path));
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
	// Codex hides the server's tools from the model where this lists.
	const omitted = table.omit_tools_from;
	if (omitted != null && !(Array.isArray(omitted) && omitted.length === 0)) return "omit_tools_from";
	return undefined;
}

/**
 * The Codex key that makes some of a server's tools ask before they run (`prompt`, `writes`, or a
 * mode Scient Agent does not know), or undefined when Codex runs them all without asking. Scient
 * Agent cannot carry Codex's approval modes over, so such a server would run its tools unasked.
 */
function approvalKey(table: Record<string, unknown>): string | undefined {
	const unasked = (mode: unknown) => mode == null || mode === "auto" || mode === "approve";
	if (!unasked(table.default_tools_approval_mode)) return "default_tools_approval_mode";
	if (table.tools == null) return undefined;
	if (!isRecord(table.tools)) return "tools";
	for (const [tool, config] of Object.entries(table.tools)) {
		if (!isRecord(config) || !unasked(config.approval_mode)) return `tools.${tool}.approval_mode`;
	}
	return undefined;
}

const isStringList = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every(item => typeof item === "string");
const isStringMap = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every(item => typeof item === "string");
const isString = (value: unknown) => typeof value === "string";
const isBoolean = (value: unknown) => typeof value === "boolean";
const isPositiveInteger = (value: unknown) => Number.isInteger(value) && (value as number) > 0;
/** Seconds Rust's `Duration::try_from_secs_f64` takes, as Codex converts them: finite, not negative, under 2^64. */
const isDurationSeconds = (value: unknown) =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 && value < 2 ** 64;
const isApprovalMode = (value: unknown) => ["auto", "prompt", "writes", "approve"].includes(value as string);

/** Codex's string fields of a legacy manifest's `interface` (camelCase, with its URL aliases). */
const INTERFACE_STRINGS = [
	"displayName",
	"shortDescription",
	"longDescription",
	"developerName",
	"category",
	"websiteUrl",
	"websiteURL",
	"privacyPolicyUrl",
	"privacyPolicyURL",
	"termsOfServiceUrl",
	"termsOfServiceURL",
	"brandColor",
	"composerIcon",
	"logo",
	"logoDark",
];

/** The first legacy manifest field whose type Codex rejects, which makes it skip the plugin, or undefined. */
function manifestTypeError(manifest: Record<string, unknown>): string | undefined {
	// `name` and `keywords` cannot be null; the other fields may be.
	if ("name" in manifest && !isString(manifest.name)) return "name";
	if ("keywords" in manifest && !isStringList(manifest.keywords)) return "keywords";
	for (const key of ["version", "description", "apps"]) {
		if (manifest[key] != null && !isString(manifest[key])) return key;
	}
	const ui = manifest.interface;
	if (ui == null) return undefined;
	if (!isRecord(ui)) return "interface";
	for (const key of ["capabilities", "screenshots"]) {
		if (key in ui && !isStringList(ui[key])) return `interface.${key}`;
	}
	for (const key of INTERFACE_STRINGS) if (ui[key] != null && !isString(ui[key])) return `interface.${key}`;
	return undefined;
}

/**
 * The types Codex accepts for a legacy server's fields (null counts as absent); it rejects a server
 * with any other, so its siblings load without it.
 */
const SERVER_FIELD_TYPES: Record<string, (value: unknown) => boolean> = {
	command: isString,
	args: isStringList,
	env: isStringMap,
	cwd: isString,
	http_headers: isStringMap,
	env_http_headers: isStringMap,
	url: isString,
	bearer_token: isString,
	bearer_token_env_var: isString,
	http_headers_helper: isString,
	environment_id: isString,
	auth: value => value === "oauth" || value === "chatgpt" || value === "ema_auth",
	startup_timeout_sec: isDurationSeconds,
	startup_timeout_ms: value => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 2 ** 64,
	tool_timeout_sec: isDurationSeconds,
	enabled: isBoolean,
	required: isBoolean,
	supports_parallel_tool_calls: isBoolean,
	startup_readiness: value => value === "connection" || value === "catalog",
	tool_input_schema_max_bytes: isPositiveInteger,
	omit_tools_from: value =>
		isStringList(value) && value.every(surface => ["code_mode", "deferred", "direct"].includes(surface)),
	default_tools_approval_mode: isApprovalMode,
	enabled_tools: isStringList,
	disabled_tools: isStringList,
	scopes: isStringList,
	oauth: value =>
		isRecord(value) &&
		["client_id", "client_secret", "callback_url", "authorization_server_issuer", "token_endpoint_auth_method"].every(
			key => value[key] == null || isString(value[key]),
		) &&
		(value.callback_port == null ||
			(Number.isInteger(value.callback_port) &&
				(value.callback_port as number) >= 0 &&
				(value.callback_port as number) <= 65535)),
	oauth_resource: isString,
	name: isString,
	tools: value =>
		isRecord(value) &&
		Object.values(value).every(
			tool =>
				isRecord(tool) &&
				(tool.approval_mode == null || isApprovalMode(tool.approval_mode)) &&
				(tool.output_token_limit == null || isPositiveInteger(tool.output_token_limit)),
		),
};

/**
 * The names of Codex's `env_vars` entries (a name, or `{ name, source = "local" }` with no other
 * keys); null when one is malformed.
 */
function envVarNames(value: unknown): string[] | null {
	if (value == null) return [];
	if (!Array.isArray(value)) return null;
	const names: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string") names.push(entry);
		else if (
			isRecord(entry) &&
			typeof entry.name === "string" &&
			(entry.source ?? "local") === "local" &&
			Object.keys(entry).every(key => key === "name" || key === "source")
		) {
			names.push(entry.name);
		} else return null;
	}
	return names;
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
	const mistyped = Object.keys(SERVER_FIELD_TYPES).find(
		key => server[key] != null && !SERVER_FIELD_TYPES[key](server[key]),
	);
	if (mistyped !== undefined) return { error: `invalid ${mistyped}` };
	// Another environment runs the server for Codex; here it would run on this machine.
	if (server.environment_id != null && server.environment_id !== "local") {
		return { error: `it runs in Codex environment ${server.environment_id}` };
	}
	const isStdio = server.command != null;
	if (!isStdio && server.url == null) return { error: "it declares neither command nor url" };
	const wrong = (isStdio ? NOT_STDIO : NOT_HTTP).find(key => server[key] != null);
	if (wrong !== undefined) return { error: `${wrong} is not supported for ${isStdio ? "stdio" : "streamable HTTP"}` };
	const common = {
		// `enabled = false` in the declaration turns the server off in Codex.
		...(server.enabled === false && { enabled: false }),
		...(typeof server.tool_timeout_sec === "number" &&
			server.tool_timeout_sec > 0 && { timeout: server.tool_timeout_sec * 1000 }),
	};

	if (isStdio) {
		const command = (server.command as string).trim();
		if (!command) return { error: "command is empty" };
		const forwarded = envVarNames(server.env_vars);
		if (forwarded === null) return { error: "invalid env_vars" };
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
				env: stdioEnv(env, forwarded, server.env as Record<string, string> | undefined),
				envPolicy: "literal",
				envInherit: [],
				cwd,
				...common,
			},
		};
	}

	if (server.http_headers_helper != null) return { error: "it computes its headers with a helper command" };
	if (server.auth != null && server.auth !== "oauth") return { error: `auth ${String(server.auth)} is not supported` };
	const url = server.url as string;
	if (!URL.canParse(url) || !/^https?:$/.test(new URL(url).protocol)) return { error: `invalid url ${url}` };
	// Static headers are data; the others name variables of the launch environment, as in Codex.
	const headers: Record<string, string> = { ...(server.http_headers as Record<string, string> | undefined) };
	for (const [header, name] of Object.entries((server.env_http_headers ?? {}) as Record<string, string>)) {
		const value = envValue(env, name)?.trim();
		if (value) headers[header] = value;
	}
	const bearer = server.bearer_token_env_var ? envValue(env, server.bearer_token_env_var as string)?.trim() : "";
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
			...common,
		},
	};
}

/** A legacy server map: the manifest's inline map, its named file, or the package's `.mcp.json`. */
async function readLegacyServerMap(
	plugin: CodexPlugin,
	manifest: Record<string, unknown>,
	manifestPath: string,
	warnings: string[],
): Promise<{ servers: Record<string, unknown>; sourcePath: string } | null> {
	const declared = manifest.mcpServers;
	let parsed: unknown = declared;
	let sourcePath = manifestPath;
	if (!isRecord(declared)) {
		// Codex drops a path it does not take, or a value of another type, and reads `.mcp.json` instead.
		const relative = manifestRelative(declared);
		if (declared != null && relative === null) {
			warnings.push(`[codex-plugins] Ignoring mcpServers of ${plugin.id}, which is not a ./path without ..`);
		}
		const file = await packagePath(plugin, relative ?? ".mcp.json", "mcpServers", warnings);
		if (file === null) {
			if (relative !== null) warnings.push(`[codex-plugins] Missing mcpServers file declared by ${plugin.id}`);
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

/**
 * An Agent Plugins package's `mcp.json`, read under that standard and Codex's rules for it: the
 * file must be a regular file at the root, `sse` servers do not run, and a stdio server takes the
 * `env_vars` a valid `.codex-plugin` declaration of the same stdio server adds (dropping the
 * `${NAME}` placeholders those variables replace).
 */
async function readStandardServers(
	ctx: LoadContext,
	plugin: CodexPlugin,
	env: Record<string, string>,
	warnings: string[],
): Promise<{ servers: Record<string, Partial<MCPServer>>; sourcePath: string } | null> {
	const file = path.join(plugin.root, "mcp.json");
	const stat = await lstatOrNull(file);
	if (stat === null) return null;
	if (!stat.isFile()) {
		warnings.push(`[codex-plugins] ${plugin.id}: mcp.json is not a regular file`);
		return null;
	}
	const raw = await readFile(file);
	if (raw === null) return null;
	const digest = new Bun.CryptoHasher("sha256").update(`codex:${plugin.id}`).digest("hex").slice(0, 16);
	const pluginData = path.join(getPluginsDir(ctx.home), "data", `codex-${plugin.name}-${digest}`);
	const result = await parseAgentPluginMcp(raw, { pluginRoot: plugin.root, pluginData });
	if (result.status === "disabled") {
		warnings.push(`[codex-plugins] ${plugin.id}: MCP disabled: ${result.reason}`);
		return null;
	}
	warnings.push(...result.warnings.map(warning => `[codex-plugins] ${plugin.id}: ${warning}`));
	// Codex overlays only a valid `.codex-plugin` declaration of a valid stdio server.
	const codexManifest = await readLegacyManifest(plugin.root, plugin.id, [], LEGACY_MANIFESTS.slice(0, 1));
	const overlay =
		codexManifest &&
		(await readLegacyServerMap(plugin, codexManifest.manifest, codexManifest.manifestPath, []))?.servers;
	const servers: Record<string, Partial<MCPServer>> = {};
	for (const { name, ...server } of result.servers) {
		if (server.transport === "sse") {
			warnings.push(`[codex-plugins] Skipping MCP server "${name}" of ${plugin.id}: Codex does not run sse servers`);
			continue;
		}
		if (server.transport !== "stdio") {
			servers[name] = { ...server, headerPolicy: "origin-locked" };
			continue;
		}
		const declared = overlay?.[name];
		let forwarded: string[] = [];
		if (isRecord(declared)) {
			const mapped = await mapLegacyServer(plugin, declared, env).catch(() => null);
			if (mapped !== null && "server" in mapped && mapped.server.transport === "stdio") {
				forwarded = envVarNames(declared.env_vars) ?? [];
			}
		}
		// A `${NAME}` placeholder for a forwarded variable gives way to that variable's real value.
		const kept = Object.entries(server.env ?? {}).filter(
			([key, value]) =>
				!forwarded.some(variable => sameEnvName(key, variable) && sameEnvName(value, `\${${variable}}`)),
		);
		servers[name] = {
			...server,
			env: stdioEnv(env, forwarded, Object.fromEntries(kept)),
			envPolicy: "literal",
			envInherit: [],
		};
	}
	if (Object.values(servers).some(server => server.transport === "stdio"))
		await fs.mkdir(pluginData, { recursive: true });
	return { servers, sourcePath: file };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	if (!isUserSourceEnabled(PROVIDER_ID, ctx)) return { items: [] };
	const { plugins, warnings, env } = await listCodexPlugins(ctx);
	const items: MCPServer[] = [];
	for (const plugin of plugins) {
		const policies = isRecord(plugin.config.mcp_servers) ? plugin.config.mcp_servers : {};
		const standard = plugin.format === "standard" ? await readStandardServers(ctx, plugin, env, warnings) : null;
		const legacy =
			plugin.format === "legacy"
				? await readLegacyServerMap(plugin, plugin.manifest, plugin.manifestPath, warnings)
				: null;
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
			const restricted =
				toolFilterKey(server) ?? toolFilterKey(policy) ?? approvalKey(server) ?? approvalKey(policy);
			if (restricted !== undefined) {
				warnings.push(`${skip}: Codex restricts its tools (${restricted}), which Scient Agent cannot enforce`);
				continue;
			}
			// An `ema_auth` entry stands for the enterprise sign-in Codex no longer supports there; Codex
			// turns the server off for good, so no setting here may turn it back on.
			if ("ema_auth" in policy) {
				warnings.push(`${skip}: Codex turns it off (ema_auth)`);
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
				// The plugin's `mcp_servers.<name>` table turns the server off with `enabled = false`.
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
