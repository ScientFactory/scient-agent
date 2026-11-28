import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const PREFIX = "unix:";

function requireNoGrantingMacAcl(paths: string[]): void {
	if (process.platform !== "darwin") return;
	// Darwin ACL grants can bypass mode bits. Deny-only home ACLs are harmless.
	const listing = Bun.spawnSync(["/bin/ls", "-dle", ...paths], {
		env: { LC_ALL: "C" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	if (listing.exitCode !== 0 || /^ *\d+:.*\ballow /m.test(listing.stdout.toString())) {
		throw new Error("Auth broker Unix endpoint requires a path without granting macOS ACLs");
	}
}

/** Both ends require a private directory that another local user cannot replace. */
export function privateBrokerSocket(endpoint: string): string | undefined {
	if (!endpoint.startsWith(PREFIX)) return undefined;
	const socket = endpoint.slice(PREFIX.length);
	const uid = process.geteuid?.();
	if (
		uid === undefined ||
		!path.isAbsolute(socket) ||
		path.normalize(socket) !== socket ||
		socket.endsWith("/") ||
		socket.includes("\0") ||
		socket.includes("\n") ||
		socket.includes("\r") ||
		Buffer.byteLength(socket) > (process.platform === "darwin" ? 103 : 107)
	) {
		throw new Error("Auth broker requires an absolute Unix socket path that fits in sockaddr_un");
	}

	let dir = path.dirname(socket);
	const parent = fs.lstatSync(dir);
	if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) {
		throw new Error("Auth broker Unix socket must be in a private directory owned by the current user");
	}
	const ancestry = [dir];
	while (dir !== path.dirname(dir)) {
		dir = path.dirname(dir);
		ancestry.push(dir);
		const ancestor = fs.lstatSync(dir);
		const sticky = (ancestor.mode & 0o1000) !== 0;
		if (
			!ancestor.isDirectory() ||
			(ancestor.uid !== 0 && ancestor.uid !== uid) ||
			((ancestor.mode & 0o022) !== 0 && !sticky)
		) {
			throw new Error("Auth broker Unix socket directory has an untrusted ancestor");
		}
	}
	requireNoGrantingMacAcl(ancestry.reverse());
	return socket;
}

/** Unix endpoints always use the token in their private directory, never the client's config. */
export async function unixBrokerCredentials(url: string | undefined): Promise<{ url: string; token: string } | null> {
	if (url === undefined) return null;
	const socket = privateBrokerSocket(url);
	if (socket === undefined) return null;

	const filename = path.join(path.dirname(socket), "auth-broker.token");
	await using file = await fsp.open(
		filename,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
	);
	requireNoGrantingMacAcl([filename]);
	const stat = await file.stat();
	if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0) {
		throw new Error("Auth broker token must be a private file owned by the current user");
	}
	const token = (await file.readFile("utf8")).trim();
	if (!token) throw new Error("Auth broker token file is empty");
	return { url, token };
}

export function brokerTransport(url: string, fetchImpl: typeof fetch): { url: string; fetch: typeof fetch } {
	const unix = privateBrokerSocket(url);
	if (unix === undefined) return { url, fetch: fetchImpl };
	return {
		url: "http://localhost",
		fetch: Object.assign(
			(input: string | URL | Request, init?: RequestInit) =>
				fetchImpl(input, { ...init, unix, proxy: "", redirect: "error" }),
			{ preconnect: fetchImpl.preconnect },
		),
	};
}
