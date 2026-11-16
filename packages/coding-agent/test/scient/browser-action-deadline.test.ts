import { expect, spyOn, test } from "bun:test";
import * as os from "node:os";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";
import { TernTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import { TernError, TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "../tools/tern-fake-daemon";

const BUTTON = { ref: "e1-5", tag: "button", states: [], rect: [20, 10, 40, 20] };
const ACTIONABLE = { state: "ok", point: [40, 20], node: BUTTON };

interface ActionClock {
	expire(): void;
	parent: AbortController;
	onSleep?: (ms: number) => void;
}

async function withNativeTab(
	answer: (request: Record<string, unknown>, clock: ActionClock) => FakeAnswer,
	run: (tab: TernTab, daemon: FakeDaemon, clock: ActionClock, client: TernSocketClient) => Promise<void>,
): Promise<void> {
	let now = Date.now();
	let started = now;
	const clock: ActionClock = {
		expire: () => {
			now = started + 150;
		},
		parent: new AbortController(),
	};
	const daemon = await startFakeDaemon(op => (op.op === "dom" ? answer(op, clock) : { ok: {} }), {
		welcome: { ops: ["dom"] },
	});
	const client = new TernSocketClient({ socketPath: daemon.socketPath });
	try {
		await client.connect();
		started = now = Date.now();
		using _clock = spyOn(Date, "now").mockImplementation(() => now);
		using _sleep = spyOn(Bun, "sleep").mockImplementation(async ms => {
			if (clock.onSleep) clock.onSleep(Number(ms));
			else now += Number(ms);
		});
		const tab = new TernTab({ client, block: 7, name: "main", viewport: { width: 800, height: 600 } });
		tab.setRunContext({
			timeoutMs: 1_150,
			deadline: started + 1_150,
			signal: clock.parent.signal,
			session: { cwd: os.tmpdir() },
			output: new RunOutput(),
			screenshots: [],
		});
		await run(tab, daemon, clock, client);
	} finally {
		client.close();
		await daemon.close();
	}
}

const rejected = (pending: Promise<unknown>): Promise<unknown> =>
	pending.then(
		() => undefined,
		error => error,
	);

function expectActionTimeout(error: unknown): void {
	expect(error).toBeInstanceOf(ToolError);
	expect(error).not.toBeInstanceOf(TernError);
}

test("an action deadline reached during retry sleep cannot send a later click", async () => {
	let resolves = 0;
	await withNativeTab(
		request => {
			if (request.read === "query") return { ok: { nodes: [BUTTON], total: 1 } };
			return { ok: resolves++ === 0 ? { state: "unstable", node: BUTTON } : ACTIONABLE };
		},
		async (tab, daemon, clock) => {
			clock.onSleep = () => clock.expire();
			expectActionTimeout(await rejected(tab.click("#target")));
			expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
			expect(resolves).toBe(1);
		},
	);
});

test("a query that consumes the remaining deadline cannot start another resolve or click", async () => {
	let queries = 0;
	let resolves = 0;
	await withNativeTab(
		(request, clock) => {
			if (request.read === "query") {
				if (++queries === 2) clock.expire();
				return { ok: { nodes: [BUTTON], total: 1 } };
			}
			return { ok: resolves++ === 0 ? { state: "detached", node: BUTTON } : ACTIONABLE };
		},
		async (tab, daemon) => {
			expectActionTimeout(await rejected(tab.click("#target")));
			expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
			expect(resolves).toBe(1);
		},
	);
});

test("an actionable resolve arriving at the deadline cannot authorize input", async () => {
	await withNativeTab(
		(request, clock) => {
			if (request.read === "query") return { ok: { nodes: [BUTTON], total: 1 } };
			clock.expire();
			return { ok: ACTIONABLE };
		},
		async (tab, daemon) => {
			expectActionTimeout(await rejected(tab.click("#target")));
			expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
		},
	);
});

test("a request timeout at the action deadline retains the recorded actionability failure", async () => {
	await withNativeTab(
		request =>
			request.read === "query" ? { ok: { nodes: [BUTTON], total: 1 } } : { ok: { state: "detached", node: BUTTON } },
		async (tab, daemon, clock, client) => {
			const send = client.request.bind(client);
			let queries = 0;
			using _request = spyOn(client, "request").mockImplementation((op, options) => {
				if (op.op === "dom" && op.read === "query" && ++queries === 2) {
					clock.expire();
					return Promise.reject(new TernError("timeout", "fixture request deadline"));
				}
				return send(op, options);
			});
			expectActionTimeout(await rejected(tab.click("#target")));
			expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
		},
	);
});

test("parent cancellation wins over an exhausted action deadline", async () => {
	const cancelled = new Error("parent cancelled");
	let queries = 0;
	await withNativeTab(
		(request, clock) => {
			if (request.read === "query") {
				if (++queries === 2) {
					clock.expire();
					clock.parent.abort(cancelled);
					return null;
				}
				return { ok: { nodes: [BUTTON], total: 1 } };
			}
			return { ok: { state: "detached", node: BUTTON } };
		},
		async (tab, daemon) => {
			expect(await rejected(tab.click("#target"))).toBe(cancelled);
			expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
		},
	);
});

test("the action deadline cancels a pending read rather than a shorter transport timer winning", async () => {
	let queries = 0;
	await withNativeTab(
		request => {
			if (request.read === "query") {
				return ++queries === 2 ? null : { ok: { nodes: [BUTTON], total: 1 } };
			}
			return { ok: { state: "detached", node: BUTTON } };
		},
		async (tab, daemon) => {
			expectActionTimeout(await rejected(tab.click("#target")));
			expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
		},
	);
});

test.each(["timeout", "protocol"] as const)(
	"a backend %s before the action deadline is not replaced with an action timeout",
	async kind => {
		await withNativeTab(
			request =>
				request.read === "query"
					? { ok: { nodes: [BUTTON], total: 1 } }
					: { ok: { state: "detached", node: BUTTON } },
			async (tab, daemon, _clock, client) => {
				const failure = new TernError(kind, "fixture backend failure");
				const send = client.request.bind(client);
				let queries = 0;
				using _request = spyOn(client, "request").mockImplementation((op, options) =>
					op.op === "dom" && op.read === "query" && ++queries === 2 ? Promise.reject(failure) : send(op, options),
				);
				expect(await rejected(tab.click("#target"))).toBe(failure);
				expect(daemon.requests.filter(request => request.op.op === "input")).toEqual([]);
			},
		);
	},
);
