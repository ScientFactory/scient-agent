import { $env } from "@oh-my-pi/pi-utils";

/** Host additions affect discovery only; settings readers and writers keep their own set. */
export function withHostEnabledSources(configured: ReadonlySet<string>): ReadonlySet<string> {
	const additions = ($env.SCIENT_AGENT_ENABLE_SOURCES ?? "")
		.split(/[\s,]+/)
		.filter(id => id === "*" || /^[a-z][a-z0-9-]*$/.test(id));
	return additions.length === 0 ? configured : new Set([...configured, ...additions]);
}
