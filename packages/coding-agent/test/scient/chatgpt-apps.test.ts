import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { ChatGptAppsClient, ChatGptAppsError, chatGptAppConnectUrl, rpcResponse } from "../../src/scient/chatgpt-apps";
import {
	chatGptToolName,
	chosenByPolicy,
	createChatGptAppsExtension,
	registeredExtensionToolNames,
	requestedChatGptApps,
} from "../../src/scient/chatgpt-apps-extension";
import { AuthStorage } from "../../src/session/auth-storage";

const GMAIL = "connector_2128aebfecb84f64a069897515042a44";
const DRIVE = "connector_5f3c8c41a1e54ad7a76272c89e2554fa";

const tool = (name: string, appId: string, appName: string, readOnly = false) => ({
	name,
	description: `${name} description`,
	inputSchema: { type: "object", properties: {} },
	annotations: { readOnlyHint: readOnly },
	_meta: { connector_id: appId, connector_name: appName, connector_description: `${appName} tools` },
});

const CATALOG = [
	tool("gmail.search_emails", GMAIL, "Gmail", true),
	tool("gmail.send_email", GMAIL, "Gmail"),
	tool("google_drive.fetch", DRIVE, "Google Drive", true),
	tool("pets.adopt", "connector_openai_chatgpt_pets", "Pets"),
];

/** A ChatGPT apps server: event-stream answers, one session id, and the calls it received. */
function fakeServer(options: { expireSessionOnce?: boolean; call?: unknown } = {}) {
	const requests: Array<{ method: string; session: string | null; headers: Headers; params: unknown }> = [];
	let sessions = 0;
	let expire = options.expireSessionOnce === true;
	const spy = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		const body = JSON.parse(String(init?.body));
		requests.push({ method: body.method, session: headers.get("mcp-session-id"), headers, params: body.params });
		if (body.method === "initialize") {
			sessions++;
			return new Response(
				`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {} })}\n\n`,
				{
					headers: { "content-type": "text/event-stream", "mcp-session-id": `session-${sessions}` },
				},
			);
		}
		if (body.id === undefined) return new Response(null, { status: 202 });
		if (expire && body.method !== "initialize") {
			expire = false;
			return new Response("Session not found", { status: 404 });
		}
		const result = body.method === "tools/list" ? { tools: CATALOG } : (options.call ?? { content: [] });
		return Response.json({ jsonrpc: "2.0", id: body.id, result });
	}) as typeof fetch);
	return { spy, requests };
}

describe("ChatGPT apps through the ChatGPT sign-in", () => {
	let authStorage: AuthStorage;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
	});
	afterEach(() => {
		authStorage.close();
	});

	const signIn = () =>
		authStorage.credentials.set("openai-codex", [
			{
				type: "oauth",
				access: "access-1",
				refresh: "refresh-1",
				expires: Date.now() + 600_000,
				accountId: "acct-1",
			},
		]);

	it("lists the connected apps with the sign-in, leaving out ChatGPT's own features", async () => {
		await signIn();
		const { spy, requests } = fakeServer();
		try {
			const apps = await new ChatGptAppsClient(authStorage).listApps();
			expect(apps.map(app => [app.name, app.tools.map(t => t.name)])).toEqual([
				["Gmail", ["gmail.search_emails", "gmail.send_email"]],
				["Google Drive", ["google_drive.fetch"]],
			]);
			expect(apps[0]?.tools[0]?.readOnly).toBe(true);
			expect(String(spy.mock.calls[0]![0])).toBe("https://chatgpt.com/backend-api/ps/mcp");
			expect(requests.map(r => r.method)).toEqual(["initialize", "notifications/initialized", "tools/list"]);
			const list = requests[2]!;
			expect(list.session).toBe("session-1");
			expect(list.headers.get("authorization")).toBe("Bearer access-1");
			expect(list.headers.get("chatgpt-account-id")).toBe("acct-1");
			expect(list.headers.get("x-openai-product-sku")).toBe("codex");
		} finally {
			spy.mockRestore();
		}
	});

	it("opens a new session once when ChatGPT has forgotten the old one", async () => {
		await signIn();
		const client = new ChatGptAppsClient(authStorage);
		const first = fakeServer();
		await client.listApps();
		first.spy.mockRestore();
		const { spy, requests } = fakeServer({
			expireSessionOnce: true,
			call: { content: [{ type: "text", text: "ok" }] },
		});
		try {
			const result = await client.callTool("gmail.search_emails", { query: "" });
			expect(result.content).toEqual([{ type: "text", text: "ok" }]);
			expect(requests.map(r => r.method)).toEqual([
				"tools/call",
				"initialize",
				"notifications/initialized",
				"tools/call",
			]);
			expect(requests.filter(r => r.method === "tools/call").map(r => r.params)).toEqual([
				{ name: "gmail.search_emails", arguments: { query: "" } },
				{ name: "gmail.search_emails", arguments: { query: "" } },
			]);
		} finally {
			spy.mockRestore();
		}
	});

	it("asks for a sign-in when there is none, without calling ChatGPT", async () => {
		const spy = spyOn(globalThis, "fetch");
		try {
			const error = await new ChatGptAppsClient(authStorage).listApps().catch(e => e);
			expect(error).toBeInstanceOf(ChatGptAppsError);
			expect((error as ChatGptAppsError).kind).toBe("signed-out");
			expect(spy).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});

	it("registers the chosen apps' tools and runs them through ChatGPT", async () => {
		await signIn();
		const { spy, requests } = fakeServer({
			call: { content: [], structuredContent: { emails: [{ subject: "Lab meeting" }] } },
		});
		const registered: Array<{ name: string; description: string; execute: Function; mcpReadOnlyHint?: boolean }> = [];
		try {
			const policy = requestedChatGptApps({ SCIENT_AGENT_CHATGPT_APPS: `all,-${DRIVE}` })!;
			await createChatGptAppsExtension(
				authStorage,
				policy,
			)({ registerTool: (t: never) => registered.push(t) } as never);
			expect(registered.map(t => t.name)).toEqual(["gmail__search_emails", "gmail__send_email"]);
			expect(registered[0]?.description).toStartWith("Gmail, through the person's ChatGPT account:");
			expect(registered[0]?.mcpReadOnlyHint).toBe(true);
			const output = await registered[0]!.execute("call-1", { query: "lab" }, undefined);
			expect(output.content).toEqual([{ type: "text", text: '{"emails":[{"subject":"Lab meeting"}]}' }]);
			expect(requests.at(-1)?.params).toEqual({ name: "gmail.search_emails", arguments: { query: "lab" } });
		} finally {
			spy.mockRestore();
		}
	});

	it("turns an app's error and a lost link into errors the model can explain", async () => {
		await signIn();
		const { spy } = fakeServer({
			call: { content: [], isError: true, _meta: { connector_auth_failure: { is_auth_failure: true } } },
		});
		const registered: Array<{ execute: Function }> = [];
		try {
			const policy = requestedChatGptApps({ SCIENT_AGENT_CHATGPT_APPS: GMAIL })!;
			await createChatGptAppsExtension(
				authStorage,
				policy,
			)({ registerTool: (t: never) => registered.push(t) } as never);
			const error = await registered[0]!.execute("call-1", {}, undefined).catch((e: Error) => e);
			expect(String(error.message)).toContain(`connected again in ChatGPT`);
			expect(String(error.message)).toContain(`https://chatgpt.com/apps/gmail/${GMAIL}`);
		} finally {
			spy.mockRestore();
		}
	});

	it("keeps an existing connector's name and calls the ChatGPT fallback with its original remote name", async () => {
		await signIn();
		const { spy, requests } = fakeServer();
		const registered: Array<{ name: string; execute: Function }> = [];
		try {
			const preferred = registeredExtensionToolNames([{ tools: new Map([["gmail__search_emails", {}]]) }]);
			await createChatGptAppsExtension(
				authStorage,
				requestedChatGptApps({ SCIENT_AGENT_CHATGPT_APPS: GMAIL })!,
				() => preferred,
			)({ registerTool: (definition: never) => registered.push(definition) } as never);
			expect(registered.map(entry => entry.name)).toEqual(["chatgpt__gmail__search_emails", "gmail__send_email"]);
			await registered[0]!.execute("fallback", { query: "lab" }, undefined);
			expect(requests.at(-1)?.params).toEqual({ name: "gmail.search_emails", arguments: { query: "lab" } });
		} finally {
			spy.mockRestore();
		}
	});
});

describe("the host's choice of apps", () => {
	it("reads all, ids and exclusions, and nothing without the variable", () => {
		expect(requestedChatGptApps({})).toBeUndefined();
		expect(requestedChatGptApps({ SCIENT_AGENT_CHATGPT_APPS: `-${GMAIL}` })).toBeUndefined();
		const policy = requestedChatGptApps({ SCIENT_AGENT_CHATGPT_APPS: ` all , -${GMAIL}, bad id ` })!;
		expect(policy).toEqual({ all: true, include: [], exclude: [GMAIL] });
		expect(chosenByPolicy(policy, GMAIL)).toBe(false);
		expect(chosenByPolicy(policy, DRIVE)).toBe(true);
		const named = requestedChatGptApps({ SCIENT_AGENT_CHATGPT_APPS: DRIVE })!;
		expect(chosenByPolicy(named, DRIVE)).toBe(true);
		expect(chosenByPolicy(named, GMAIL)).toBe(false);
	});

	it("names tools by app and keeps long names within 64 characters", () => {
		const app = { id: GMAIL, name: "Gmail", tools: [] };
		expect(chatGptToolName(app, "gmail.search_emails")).toBe("gmail__search_emails");
		expect(chatGptToolName({ ...app, name: "Google Drive" }, "fetch")).toBe("google_drive__fetch");
		const long = chatGptToolName(app, `gmail.${"x".repeat(80)}`);
		expect(long.length).toBe(64);
		expect(long).toMatch(/^gmail__x+_[0-9a-f]{8}$/);
	});

	it("builds ChatGPT's connect page and reads event-stream answers", () => {
		expect(chatGptAppConnectUrl({ id: "connector_x", name: "Google Calendar" })).toBe(
			"https://chatgpt.com/apps/google-calendar/connector_x",
		);
		const body = `event: message\r\ndata: {"jsonrpc":"2.0","method":"note","id":3}\r\n\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":3,"result":{"ok":true}}\r\n\r\n`;
		expect(rpcResponse(body, true, 3)).toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
	});
});

describe("one ChatGPT account per client", () => {
	it("refuses a call once the sign-in resolves to another account", async () => {
		const authStorage = await AuthStorage.create(":memory:");
		try {
			await authStorage.credentials.set("openai-codex", [
				{ type: "oauth", access: "access-a", refresh: "r", expires: Date.now() + 600_000, accountId: "acct-a" },
			]);
			const client = new ChatGptAppsClient(authStorage);
			const spy = spyOn(globalThis, "fetch").mockImplementation((async (_url: unknown, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body));
				if (body.id === undefined) return new Response(null, { status: 202 });
				return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [], content: [] } });
			}) as typeof fetch);
			try {
				await client.listApps();
				await authStorage.credentials.set("openai-codex", [
					{ type: "oauth", access: "access-b", refresh: "r", expires: Date.now() + 600_000, accountId: "acct-b" },
				]);
				const calls = spy.mock.calls.length;
				const error = await client.callTool("gmail.send_email", {}).catch(e => e);
				expect((error as ChatGptAppsError).kind).toBe("signed-out");
				expect(spy.mock.calls.length).toBe(calls);
			} finally {
				spy.mockRestore();
			}
		} finally {
			authStorage.close();
		}
	});
});
