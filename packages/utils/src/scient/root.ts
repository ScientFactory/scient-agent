/**
 * The config root a host (Scient Desktop) assigns with `SCIENT_AGENT_ROOT`.
 *
 * The assignment is authoritative: under a host root every file the agent owns
 * lives in it. `dirs.ts` derives the agent directory from it and ignores
 * `SCIENT_AGENT_DIR`, XDG locations and the natives override; `env.ts` lets no
 * `.env` outside the root set the agent's own variables.
 */
import * as path from "node:path";

const HOST_ROOT_ENV = "SCIENT_AGENT_ROOT";
const AGENT_ENV_PREFIX = "SCIENT_AGENT_";

/** The host-assigned config root. Unset or relative values are not an assignment. */
export function getHostConfigRoot(): string | undefined {
	const root = process.env[HOST_ROOT_ENV];
	return root && path.isAbsolute(root) ? root : undefined;
}

/**
 * Whether a `.env` file may set `key`.
 *
 * The root itself is an assignment made at launch, so no `.env` can make one:
 * it would arrive after the native addon and the logger had chosen their
 * directories. Under a host root, a `.env` outside it (the project's, the home
 * directory's) cannot set the agent's own variables: where sessions, caches and
 * settings overlays live, and which auth broker is used. One inside the root
 * still can, and a standalone agent keeps every `.env` override.
 */
export function dotenvMaySet(key: string, fileIsOutsideRoot: boolean): boolean {
	if (key === HOST_ROOT_ENV) return false;
	return !(fileIsOutsideRoot && key.startsWith(AGENT_ENV_PREFIX) && getHostConfigRoot() !== undefined);
}
