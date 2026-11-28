import { once } from "node:events";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { AuthBrokerServerHandle } from "@oh-my-pi/pi-ai/auth-broker";
import { privateBrokerSocket, unixBrokerCredentials } from "@oh-my-pi/pi-ai/scient/auth-broker-unix";
import { getConfigRootDir, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";

/** Only a refused connection on an owned socket is eligible for crash recovery. */
async function removeStaleSocket(socket: string): Promise<void> {
	const entry = await fs.lstat(socket).catch((error: unknown) => {
		if (!isEnoent(error)) throw error;
		return undefined;
	});
	if (!entry) return;
	if (!entry.isSocket() || entry.uid !== process.geteuid?.()) {
		throw new Error("Auth broker socket path already exists and is not an owned socket");
	}
	const conn = net.createConnection({ path: socket, signal: AbortSignal.timeout(1000) });
	try {
		await once(conn, "connect");
		throw new Error("Auth broker is already listening on this Unix socket");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw error;
	} finally {
		conn.destroy();
	}
	const current = await fs.lstat(socket);
	if (current.dev !== entry.dev || current.ino !== entry.ino) {
		throw new Error("Auth broker socket changed during startup; refusing to remove it");
	}
	await fs.unlink(socket);
}

/** Serialize token creation and crash recovery with other CLI starts for this socket. */
export async function startCliAuthBroker(
	bind: string,
	ensureToken: () => Promise<string>,
	start: (token: string) => AuthBrokerServerHandle,
): Promise<AuthBrokerServerHandle> {
	const socket = privateBrokerSocket(bind);
	if (socket === undefined) return start(await ensureToken());
	if (path.dirname(socket) !== path.resolve(getConfigRootDir())) {
		throw new Error("Auth broker Unix socket must be beside auth-broker.token in the config root");
	}
	return withFileLock(path.join(path.dirname(socket), "auth-broker.token"), async () => {
		await removeStaleSocket(socket);
		const existing = await unixBrokerCredentials(bind).catch((error: unknown) => {
			if (!isEnoent(error)) throw error;
			return null;
		});
		if (existing) return start(existing.token);
		await ensureToken();
		const created = await unixBrokerCredentials(bind);
		if (!created) throw new Error("Auth broker Unix bearer was not created");
		return start(created.token);
	});
}
