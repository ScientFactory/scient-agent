import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Writable } from "node:stream";
import { RpcOutputWriter } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-output";
import {
	checkSpoolSize,
	DEFAULT_SPOOL_LIMIT_BYTES,
	spoolFolderPrefix,
	spoolLimitBytes,
	sweepStaleSpools,
} from "@oh-my-pi/pi-coding-agent/scient/rpc-spool";

const scratchDirs: string[] = [];
const limitBefore = Bun.env.PI_RPC_SPOOL_MAX_BYTES;

afterEach(() => {
	for (const dir of scratchDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	if (limitBefore === undefined) delete Bun.env.PI_RPC_SPOOL_MAX_BYTES;
	else Bun.env.PI_RPC_SPOOL_MAX_BYTES = limitBefore;
});

function scratch(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scient-rpc-spool-test-"));
	scratchDirs.push(dir);
	return dir;
}

/** A sink that accepts one write and then never drains, as a host that stopped reading. */
function stalledSink(): Writable {
	return new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, _callback) {},
	});
}

/** This process's spool folders in the OS temp dir. */
function ownSpools(): string[] {
	const prefix = spoolFolderPrefix("@omp-rpc-output-").slice(1);
	return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix));
}

describe("RPC output spool", () => {
	it("names its folder for Scient Agent and the owning process", () => {
		expect(spoolFolderPrefix("@omp-rpc-output-", 4242)).toBe("@scient-agent-rpc-output-4242-");
		expect(spoolFolderPrefix("@omp-rpc-output-")).toBe(`@scient-agent-rpc-output-${process.pid}-`);
	});

	it("is capped at 2 GiB unless PI_RPC_SPOOL_MAX_BYTES names a positive integer", () => {
		delete Bun.env.PI_RPC_SPOOL_MAX_BYTES;
		expect(spoolLimitBytes()).toBe(DEFAULT_SPOOL_LIMIT_BYTES);
		Bun.env.PI_RPC_SPOOL_MAX_BYTES = "4096";
		expect(spoolLimitBytes()).toBe(4096);
		for (const invalid of ["0", "-1", "1.5", "lots", ""]) {
			Bun.env.PI_RPC_SPOOL_MAX_BYTES = invalid;
			expect(spoolLimitBytes()).toBe(DEFAULT_SPOOL_LIMIT_BYTES);
		}
		expect(() => checkSpoolSize(4096, 4096)).not.toThrow();
		expect(() => checkSpoolSize(4097, 4096)).toThrow(/has stopped reading/);
	});

	it("stops the output and removes the spool once a host that stopped reading lets it pass the cap", async () => {
		Bun.env.PI_RPC_SPOOL_MAX_BYTES = "65536";
		const before = new Set(ownSpools());
		const failures: Error[] = [];
		const writer = new RpcOutputWriter(stalledSink(), error => failures.push(error));
		const frame = `${JSON.stringify({ type: "message_update", text: "x".repeat(1024) })}\n`;
		writer.write([frame]);
		for (let i = 0; i < 32 && failures.length === 0; i++) writer.write(Array.from({ length: 8 }, () => frame));
		expect(failures).toHaveLength(1);
		expect(failures[0]!.message).toMatch(/passed 65536 bytes/);
		const created = () => ownSpools().filter(name => !before.has(name));
		expect(created()).toEqual([]);
		// A failed writer drops later frames instead of spooling them.
		writer.write([frame]);
		expect(created()).toEqual([]);
	});

	it("keeps spooling below the cap", () => {
		Bun.env.PI_RPC_SPOOL_MAX_BYTES = String(1024 * 1024);
		const before = new Set(ownSpools());
		const failures: Error[] = [];
		const writer = new RpcOutputWriter(stalledSink(), error => failures.push(error));
		const frame = `${JSON.stringify({ type: "message_update", text: "x".repeat(1024) })}\n`;
		writer.write(Array.from({ length: 64 }, () => frame));
		expect(failures).toEqual([]);
		const spools = ownSpools().filter(name => !before.has(name));
		expect(spools).toHaveLength(1);
		expect(fs.statSync(path.join(os.tmpdir(), spools[0]!, "output")).size).toBeGreaterThan(32 * 1024);
		fs.rmSync(path.join(os.tmpdir(), spools[0]!), { recursive: true, force: true });
	});

	it("sweeps only the folders whose process is gone", async () => {
		const dir = scratch();
		const names = {
			dead: "scient-agent-rpc-output-999001-AbCdEf",
			live: "scient-agent-rpc-output-999002-GhIjKl",
			own: `scient-agent-rpc-output-${process.pid}-MnOpQr`,
			stockOmp: "omp-rpc-output-StUvWx",
			unrelated: "scient-agent-rpc-output-notapid-YzAbCd",
		};
		for (const name of Object.values(names)) {
			fs.mkdirSync(path.join(dir, name));
			fs.writeFileSync(path.join(dir, name, "output"), "frames\n");
		}
		const removed = await sweepStaleSpools(dir, pid => pid === 999002);
		expect(removed).toEqual([names.dead]);
		expect(fs.readdirSync(dir).sort()).toEqual([names.live, names.own, names.stockOmp, names.unrelated].sort());
	});

	it.skipIf(process.platform === "win32")("treats a process that exists under another user as running", async () => {
		const dir = scratch();
		// pid 1 always exists; an unprivileged kill(1, 0) fails with EPERM.
		fs.mkdirSync(path.join(dir, "scient-agent-rpc-output-1-AbCdEf"));
		expect(await sweepStaleSpools(dir)).toEqual([]);
	});

	it("ignores a temp dir it cannot read", async () => {
		expect(await sweepStaleSpools(path.join(scratch(), "missing"))).toEqual([]);
	});
});
