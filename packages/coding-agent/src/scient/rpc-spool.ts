import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { $env, logger } from "@oh-my-pi/pi-utils";

/**
 * The RPC output spool: when a host stops reading, Oh My Pi appends every
 * frame it cannot deliver to a temporary file and replays it once the host
 * drains. Nothing bounds that file, and it is removed only when it drains or
 * the process exits normally. A host that stalls during a long stream (each
 * `message_update` repeats the whole message) filled a disk with 99 GB, and a
 * host that kills the agent leaves the file behind.
 *
 * Scient Agent caps the spool and names its folder for the owning process, so
 * a later agent removes the folders whose process is gone. Proposed to Oh My
 * Pi as can1357/oh-my-pi#16139.
 */

/** Folder names: `scient-agent-rpc-output-<pid>-<random>`. */
const FOLDER = /^scient-agent-rpc-output-(\d+)-/;

/** Spool size past which the agent stops instead of filling the disk. */
export const DEFAULT_SPOOL_LIMIT_BYTES = 2 * 1024 ** 3;

/** The spool folder prefix for Oh My Pi's `@omp-rpc-output-`: Scient Agent's name and this process's id. */
export function spoolFolderPrefix(upstreamPrefix: string, pid = process.pid): string {
	return `@scient-agent-${upstreamPrefix.replace(/^@omp-/, "")}${pid}-`;
}

/** The spool limit, from `PI_RPC_SPOOL_MAX_BYTES` when that is a positive integer. */
export function spoolLimitBytes(): number {
	const raw = $env.PI_RPC_SPOOL_MAX_BYTES?.trim();
	if (!raw || !/^\d+$/.test(raw)) return DEFAULT_SPOOL_LIMIT_BYTES;
	const limit = Number(raw);
	return Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_SPOOL_LIMIT_BYTES;
}

/** Fails once the spool holds more than the limit; the output writer then stops and removes it. */
export function checkSpoolSize(written: number, limit = spoolLimitBytes()): void {
	if (written <= limit) return;
	throw new Error(
		`RPC output spool passed ${limit} bytes: the host has stopped reading the agent's output (PI_RPC_SPOOL_MAX_BYTES)`,
	);
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to someone else.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Removes the spool folders in `dir` whose process is no longer running, and
 * returns their names. Folders of a running process, this process's own, and
 * anything named otherwise (a stock `omp`'s `omp-rpc-output-*` among them) stay.
 */
export async function sweepStaleSpools(
	dir: string = os.tmpdir(),
	isAlive: (pid: number) => boolean = processIsAlive,
): Promise<string[]> {
	const removed: string[] = [];
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return removed;
	}
	for (const name of names) {
		const pid = Number(FOLDER.exec(name)?.[1]);
		if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid || isAlive(pid)) continue;
		try {
			await fs.rm(path.join(dir, name), { recursive: true, force: true });
			removed.push(name);
		} catch (error) {
			logger.debug("Stale RPC output spool not removed", { name, error: String(error) });
		}
	}
	return removed;
}

/** Starts a sweep without delaying the caller; failures are only logged. */
export function startStaleSpoolSweep(): void {
	sweepStaleSpools().then(
		removed => {
			if (removed.length > 0) logger.debug("Removed stale RPC output spools", { removed });
		},
		error => logger.debug("Stale RPC output spool sweep failed", { error: String(error) }),
	);
}
