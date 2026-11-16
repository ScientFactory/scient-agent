import { expect, spyOn, test } from "bun:test";
import * as os from "node:os";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { TernTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { startFakeDaemon } from "../tools/tern-fake-daemon";

test("an action deadline reached during retry sleep cannot send a later click", async () => {
	const button = { ref: "e1-5", tag: "button", states: [], rect: [20, 10, 40, 20] };
	let resolves = 0;
	const daemon = await startFakeDaemon(
		op => {
			if (op.op === "dom" && op.read === "query") return { ok: { nodes: [button], total: 1 } };
			if (op.op === "dom" && op.read === "resolve") {
				return {
					ok:
						resolves++ === 0
							? { state: "unstable", node: button }
							: { state: "ok", point: [40, 20], node: button },
				};
			}
			return { ok: {} };
		},
		{ welcome: { ops: ["dom"] } },
	);
	const client = new TernSocketClient({ socketPath: daemon.socketPath });
	try {
		await client.connect();
		let now = Date.now();
		using _clock = spyOn(Date, "now").mockImplementation(() => now);
		using _sleep = spyOn(Bun, "sleep").mockImplementation(async () => {
			now += 150;
		});
		const tab = new TernTab({ client, block: 7, name: "main", viewport: { width: 800, height: 600 } });
		tab.setRunContext({
			timeoutMs: 1_150,
			deadline: now + 1_150,
			signal: new AbortController().signal,
			session: { cwd: os.tmpdir() },
			output: new RunOutput(),
			screenshots: [],
		});
		await expect(tab.click("#target")).rejects.toThrow();
		expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
		expect(resolves).toBe(1);
	} finally {
		client.close();
		await daemon.close();
	}
});
