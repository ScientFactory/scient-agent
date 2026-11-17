import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const BUNDLE = path.resolve(import.meta.dir, "../../src/tools/browser/relay/extension-assets/background.js.txt");

type Listener = (...args: unknown[]) => unknown;

class FakeSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;
	readyState = FakeSocket.CONNECTING;
	readonly sent: Array<{ t: string; tabs?: Array<{ tabId: number }> }> = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(
		readonly url: string,
		sockets: FakeSocket[],
	) {
		sockets.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	open() {
		this.readyState = FakeSocket.OPEN;
		this.onopen?.();
	}
	close() {
		if (this.readyState >= FakeSocket.CLOSING) return;
		this.readyState = FakeSocket.CLOSED;
		this.onclose?.();
	}
	hellos() {
		return this.sent.filter(message => message.t === "hello");
	}
}

/** Any Chrome API the test does not name: an event to listen to, or a call that resolves to nothing. */
function stub(): unknown {
	const call = () => Promise.resolve(undefined);
	return new Proxy(call, {
		get: (_target, key) => (key === "addListener" ? () => {} : key === "then" ? undefined : stub()),
	});
}

/** Runs the extension's bundle against a fake Chrome whose tab queries the test answers one by one. */
async function loadExtension() {
	const listeners = new Map<string, Listener[]>();
	const event = (name: string) => ({
		addListener: (listener: Listener) => listeners.set(name, [...(listeners.get(name) ?? []), listener]),
	});
	const fire = (name: string, ...args: unknown[]) => {
		for (const listener of listeners.get(name) ?? []) listener(...args);
	};
	const tabQueries: Array<PromiseWithResolvers<unknown[]>> = [];
	const sockets: FakeSocket[] = [];
	const known: Record<string, unknown> = {
		storage: {
			local: { get: async (defaults: object) => ({ ...defaults }), set: async () => {} },
			session: { get: async (defaults: object) => ({ ...defaults }), set: async () => {} },
			onChanged: event("storage.onChanged"),
		},
		tabs: {
			query: () => {
				const answer = Promise.withResolvers<unknown[]>();
				tabQueries.push(answer);
				return answer.promise;
			},
		},
		debugger: { getTargets: async () => [] },
		alarms: { create() {}, onAlarm: event("alarms.onAlarm") },
		runtime: { id: "test", onInstalled: event("runtime.onInstalled"), onStartup: event("runtime.onStartup") },
	};
	const chrome = new Proxy(known, {
		get: (target, key: string) =>
			key in target
				? new Proxy(target[key] as object, {
						get: (api, member: string) => (member in api ? api[member as keyof typeof api] : stub()),
					})
				: stub(),
	});
	const Socket = class extends FakeSocket {
		constructor(url: string) {
			super(url, sockets);
		}
	};
	const source = await Bun.file(BUNDLE).text();
	new Function("chrome", "WebSocket", "setTimeout", "setInterval", "clearInterval", "navigator", "crypto", source)(
		chrome,
		Socket,
		() => 0,
		() => 0,
		() => {},
		{ userAgent: "Chrome/150.0.0.0" },
		crypto,
	);
	return { fire, sockets, tabQueries };
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 10));
const tab = (tabId: number) => ({ id: tabId, url: `https://example.test/${tabId}`, title: `${tabId}`, windowId: 1 });

describe("relay extension sockets", () => {
	it("opens one socket for connect() calls that overlap, and re-dials only for a setting", async () => {
		const { fire, sockets } = await loadExtension();
		// Chrome runs the worker's own connect() and an onInstalled connect() together on a first start.
		fire("runtime.onInstalled");
		await settle();
		expect(sockets).toHaveLength(1);
		sockets[0]!.open();

		// The first start writes the instance id to local storage: not a setting.
		fire("storage.onChanged", { relayInstanceId: { newValue: "id" } }, "local");
		await settle();
		expect(sockets).toHaveLength(1);
		expect(sockets[0]!.readyState).toBe(FakeSocket.OPEN);

		fire("storage.onChanged", { port: { newValue: 9325 } }, "local");
		await settle();
		expect(sockets).toHaveLength(2);
		expect(sockets[1]!.url).toContain("ws://127.0.0.1:");
	});

	it("sends a hello only on the socket it was built for", async () => {
		const { fire, sockets, tabQueries } = await loadExtension();
		await settle();
		const first = sockets[0]!;
		first.open();
		await settle();
		expect(tabQueries).toHaveLength(1);
		// The first socket drops while its hello waits for Chrome's tab list; the keepalive dials again.
		first.close();
		fire("alarms.onAlarm", { name: "omp-relay-keepalive" });
		await settle();
		const second = sockets[1]!;
		second.open();
		await settle();
		expect(tabQueries).toHaveLength(2);
		tabQueries[1]!.resolve([tab(1), tab(2)]);
		await settle();
		// The first socket's hello, taken before tab 2 opened, must not reach the relay on the second socket.
		tabQueries[0]!.resolve([tab(1)]);
		await settle();
		expect(second.hellos().map(hello => hello.tabs?.map(snap => snap.tabId))).toEqual([[1, 2]]);
		expect(first.sent).toEqual([]);
	});
});
