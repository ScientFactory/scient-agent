/**
 * ChatGPT apps through the ChatGPT sign-in. The apps a person connected in ChatGPT (Gmail, Google
 * Drive and the rest) sit behind one MCP server of ChatGPT's, the one the Codex apps use. Each
 * request carries the stored openai-codex sign-in, which the shared OAuth retry refreshes or
 * rotates as for a model request.
 */
import { type AuthStorage, withOAuthAccess } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { wrapFetchForProxy } from "@oh-my-pi/pi-ai/utils/proxy";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";

const PROVIDER = "openai-codex";
export const CHATGPT_APPS_URL = `${CODEX_BASE_URL}/ps/mcp`;
const ORIGINATOR = "Codex Desktop";
const PROTOCOL_VERSION = "2025-06-18";
/** Bounds one response: a catalog of every connected app is a few megabytes at most. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const LIST_TIMEOUT_MS = 60_000;
/** Far above any app call; the caller's signal cancels sooner. */
const CALL_TIMEOUT_MS = 10 * 60_000;

export type ChatGptAppsFailureKind =
	/** No ChatGPT sign-in, or ChatGPT refused it after a refresh. */
	"signed-out" | "unavailable";

export class ChatGptAppsError extends Error {
	override readonly name = "ChatGptAppsError";
	constructor(
		readonly kind: ChatGptAppsFailureKind,
		message: string,
	) {
		super(message);
	}
}

export interface ChatGptAppTool {
	/** The name ChatGPT knows the tool by, such as `gmail.search_emails`. */
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly readOnly: boolean;
}

export interface ChatGptApp {
	/** ChatGPT's app id, such as `connector_2128aebfecb84f64a069897515042a44`. */
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly tools: readonly ChatGptAppTool[];
}

export interface ChatGptToolContent {
	readonly type: string;
	readonly text?: string;
	readonly data?: string;
	readonly mimeType?: string;
}

export interface ChatGptToolResult {
	readonly content: readonly ChatGptToolContent[];
	readonly structuredContent?: unknown;
	readonly isError?: boolean;
	readonly _meta?: unknown;
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** The JSON-RPC response for `id` in a JSON or event-stream body. */
export function rpcResponse(body: string, eventStream: boolean, id: number): JsonRecord | undefined {
	const messages: unknown[] = [];
	if (!eventStream) messages.push(JSON.parse(body));
	else {
		let data: string[] = [];
		for (const line of `${body}\n\n`.split(/\r\n|\r|\n/)) {
			if (line === "") {
				if (data.length > 0) messages.push(JSON.parse(data.join("\n")));
				data = [];
				continue;
			}
			const colon = line.indexOf(":");
			if ((colon === -1 ? line : line.slice(0, colon)) !== "data") continue;
			const value = colon === -1 ? "" : line.slice(colon + 1);
			data.push(value.startsWith(" ") ? value.slice(1) : value);
		}
	}
	for (const message of messages.flat()) {
		const envelope = record(message);
		// A server request may reuse the id; only a response (no method) answers it.
		if (envelope?.id === id && !("method" in envelope)) return envelope;
	}
	return undefined;
}

function toolOf(
	value: unknown,
): { app: { id: string; name: string; description?: string }; tool: ChatGptAppTool } | undefined {
	const tool = record(value);
	const meta = record(tool?._meta);
	const name = text(tool?.name);
	const appId = text(meta?.connector_id);
	const inputSchema = record(tool?.inputSchema);
	if (!name || !appId || !inputSchema) return undefined;
	return {
		app: {
			id: appId,
			name: text(meta?.connector_name) ?? appId,
			...(text(meta?.connector_description) ? { description: text(meta?.connector_description) } : {}),
		},
		tool: {
			name,
			description: text(tool?.description) ?? name,
			inputSchema,
			readOnly: record(tool?.annotations)?.readOnlyHint === true,
		},
	};
}

/**
 * ChatGPT's own features (pets, safety settings, spaces, search and the like) ride on the same
 * server under `connector_openai_*` ids. They are ChatGPT's, not apps the person connected.
 */
export function isChatGptOwnApp(id: string): boolean {
	return id.startsWith("connector_openai_");
}

/** Groups a tool catalog by the app each tool belongs to, in the catalog's order. */
export function appsFromTools(tools: readonly unknown[]): ChatGptApp[] {
	const apps = new Map<string, { id: string; name: string; description?: string; tools: ChatGptAppTool[] }>();
	for (const value of tools) {
		const parsed = toolOf(value);
		if (!parsed) continue;
		const app = apps.get(parsed.app.id) ?? { ...parsed.app, tools: [] };
		app.tools.push(parsed.tool);
		apps.set(parsed.app.id, app);
	}
	return [...apps.values()];
}

/** The ChatGPT page that connects an app to the person's ChatGPT account. */
export function chatGptAppConnectUrl(app: { readonly id: string; readonly name: string }): string {
	const slug = app.name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${new URL(CODEX_BASE_URL).origin}/apps/${slug}/${app.id}`;
}

function failure(error: unknown): ChatGptAppsError {
	if (error instanceof ChatGptAppsError) return error;
	if (error instanceof MissingApiKeyError)
		return new ChatGptAppsError("signed-out", "Sign in to ChatGPT to use its apps.");
	if (error instanceof ProviderHttpError && (error.status === 401 || error.status === 403))
		return new ChatGptAppsError("signed-out", "ChatGPT refused the sign-in. Sign in to ChatGPT again.");
	if (error instanceof ProviderHttpError)
		return new ChatGptAppsError("unavailable", `ChatGPT apps failed (${error.status}): ${error.message}`);
	return new ChatGptAppsError("unavailable", "Scient Agent could not reach ChatGPT's apps.");
}

/**
 * One MCP session with ChatGPT's apps server. The client keeps to the ChatGPT account its first
 * request used: the apps it listed belong to that account, so no later call may run through
 * another stored sign-in.
 */
export class ChatGptAppsClient {
	#session: { account: string; id: string | undefined } | undefined;
	#nextId = 0;
	/** Keeps credential resolution on one stored sign-in. */
	readonly #stickiness = crypto.randomUUID();
	#account: string | undefined;

	constructor(
		private readonly storage: AuthStorage,
		/** Defaults to the global fetch at each request. */
		private readonly fetchImpl?: typeof fetch,
	) {}

	async #post(
		access: { accessToken: string; accountId: string | undefined },
		method: string,
		params: unknown,
		signal: AbortSignal,
		notification = false,
	): Promise<JsonRecord | undefined> {
		const id = ++this.#nextId;
		const headers: Record<string, string> = {
			Authorization: `Bearer ${access.accessToken}`,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"User-Agent": `${ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
			"MCP-Protocol-Version": PROTOCOL_VERSION,
			"X-OpenAI-Product-Sku": "codex",
			[OPENAI_HEADERS.ORIGINATOR]: ORIGINATOR,
			[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
		};
		if (access.accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = access.accountId;
		const sessionId = this.#session?.id;
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;
		const response = await wrapFetchForProxy(this.fetchImpl ?? fetch, PROVIDER)(CHATGPT_APPS_URL, {
			method: "POST",
			redirect: "error",
			headers,
			body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
			signal,
		});
		const received = response.headers.get("mcp-session-id");
		if (received && this.#session) this.#session.id = received;
		if (!response.ok) {
			const body = (await response.text().catch(() => "")).trim().replaceAll(/\s+/g, " ").slice(0, 300);
			// A lost session (404) starts a new one on the next attempt.
			if (response.status === 404) this.#session = undefined;
			// The shared retry reads the status: a 401 refreshes the credential once before failing.
			throw new ProviderHttpError(body || response.statusText, response.status);
		}
		if (notification) {
			await response.body?.cancel();
			return undefined;
		}
		const length = Number(response.headers.get("content-length") ?? 0);
		if (length > MAX_RESPONSE_BYTES)
			throw new ChatGptAppsError("unavailable", "ChatGPT's apps sent too large a response.");
		const body = await response.text();
		if (body.length > MAX_RESPONSE_BYTES)
			throw new ChatGptAppsError("unavailable", "ChatGPT's apps sent too large a response.");
		const eventStream = response.headers.get("content-type")?.includes("text/event-stream") === true;
		const envelope = rpcResponse(body, eventStream, id);
		if (!envelope) throw new ChatGptAppsError("unavailable", "ChatGPT's apps sent no answer to the request.");
		const error = record(envelope.error);
		if (error)
			throw new ChatGptAppsError(
				"unavailable",
				`ChatGPT's apps refused ${method}: ${text(error.message) ?? "error"}`,
			);
		return record(envelope.result) ?? {};
	}

	/** Runs `method` in an initialized session, through the shared OAuth retry. */
	async #request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<JsonRecord> {
		const bounded = signal
			? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
			: AbortSignal.timeout(timeoutMs);
		try {
			return await withOAuthAccess(
				this.storage,
				PROVIDER,
				async oauth => {
					const access = {
						accessToken: oauth.accessToken,
						accountId: oauth.accountId ?? getCodexAccountId(oauth.accessToken),
					};
					const account = access.accountId ?? "";
					if (this.#account !== undefined && this.#account !== account)
						throw new ChatGptAppsError(
							"signed-out",
							"The ChatGPT sign-in changed. Start a new conversation to use its apps.",
						);
					this.#account = account;
					const open = async () => {
						// A session belongs to one ChatGPT account; a rotated sign-in starts its own.
						this.#session = { account, id: undefined };
						await this.#post(
							access,
							"initialize",
							{
								protocolVersion: PROTOCOL_VERSION,
								capabilities: {},
								clientInfo: { name: "scient-agent", version: "1" },
							},
							bounded,
						);
						await this.#post(access, "notifications/initialized", {}, bounded, true);
					};
					const reused = this.#session?.account === account;
					if (!reused) await open();
					try {
						return (await this.#post(access, method, params, bounded)) ?? {};
					} catch (error) {
						// ChatGPT forgot a session this process kept: open a new one and ask once more.
						if (!reused || !(error instanceof ProviderHttpError) || error.status !== 404) throw error;
						await open();
						return (await this.#post(access, method, params, bounded)) ?? {};
					}
				},
				{
					signal: bounded,
					sessionId: this.#stickiness,
					missingAccessMessage: "Sign in to ChatGPT to use its apps.",
				},
			);
		} catch (error) {
			if (signal?.aborted) throw error;
			throw failure(error);
		}
	}

	/** Every app the person connected to the ChatGPT account, with its tools. */
	async listApps(signal?: AbortSignal): Promise<ChatGptApp[]> {
		const tools: unknown[] = [];
		const seen = new Set<string>();
		let cursor: string | undefined;
		do {
			const page = await this.#request("tools/list", cursor ? { cursor } : {}, LIST_TIMEOUT_MS, signal);
			if (Array.isArray(page.tools)) tools.push(...page.tools);
			cursor = text(page.nextCursor);
			if (cursor && seen.has(cursor))
				throw new ChatGptAppsError("unavailable", "ChatGPT's app list did not finish.");
			if (cursor) seen.add(cursor);
		} while (cursor);
		return appsFromTools(tools).filter(app => !isChatGptOwnApp(app.id));
	}

	async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<ChatGptToolResult> {
		const result = await this.#request("tools/call", { name, arguments: args ?? {} }, CALL_TIMEOUT_MS, signal);
		const content = Array.isArray(result.content) ? (result.content as ChatGptToolContent[]) : [];
		return { ...result, content };
	}
}
