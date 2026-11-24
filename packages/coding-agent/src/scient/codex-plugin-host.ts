import { getLaunchEnv } from "@oh-my-pi/pi-utils";

/** Set by discovery on imported configs. Config spreads retain it, while MCP JSON files cannot set it. */
export const codexPluginServer = Symbol("codex-plugins server");

/** An omitted allowlist leaves the upstream worker environment policy in charge. */
export function codexStdioSpawnEnv(
	allowlist: string[] | undefined,
	declared: Record<string, string>,
): Record<string, string> | undefined {
	if (!allowlist) return undefined;
	if (allowlist.length === 0) return declared;
	// Windows treats differently cased names as one variable, including declared overrides.
	const key = (name: string) => (process.platform === "win32" ? name.toUpperCase() : name);
	const wanted = new Set(allowlist.map(key));
	for (const name of Object.keys(declared)) wanted.delete(key(name));
	const inherited = Object.entries(getLaunchEnv() ?? {}).filter(([name]) => wanted.has(key(name)));
	return { ...Object.fromEntries(inherited), ...declared };
}
