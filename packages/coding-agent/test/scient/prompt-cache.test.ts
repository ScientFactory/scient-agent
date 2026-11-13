import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, Usage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { withPromptCache } from "@oh-my-pi/pi-coding-agent/scient/prompt-cache";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const LONG_TTL_MS = 3_600_000;

function reply(model: Model): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		timestamp: Date.now(),
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 250_000,
			totalTokens: 250_002,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		} satisfies Usage,
	};
}

describe("message_end carries the confirmed prompt-cache entry", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let warmer: CacheWarmer;

	async function createSession(model: Model): Promise<void> {
		warmer?.cancel();
		authStorage?.close();
		const agentDir = tempDir.path();
		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		warmer = new CacheWarmer({
			getMode: () => "off",
			getPromptTokens: () => 250_000,
			stream: async () => {
				throw new Error("no refresh expected");
			},
		});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			cacheWarmer: warmer,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
		});
	}

	/** One main-loop request whose response wrote the prompt cache; returns its message_end. */
	function respond(model: Model): AgentSessionEvent {
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "long" });
		const message = reply(model);
		warmer.onResponse(message);
		return { type: "message_end", message };
	}

	beforeEach(() => {
		vi.useFakeTimers();
		tempDir = TempDir.createSync("@scient-prompt-cache-");
	});

	afterEach(async () => {
		warmer.cancel();
		vi.useRealTimers();
		authStorage?.close();
		authStorage = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	it("reports a confirmed one-hour entry from the request's send time, until it lapses", async () => {
		const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), promptCache: { long: 3600 } } as Model;
		await createSession(model);
		const sentAt = Date.now();
		const event = respond(model);

		expect(withPromptCache(event, session)).toMatchObject({
			promptCache: { tier: "long", touchedAt: sentAt, ttlMs: LONG_TTL_MS },
		});
		vi.advanceTimersByTime(LONG_TTL_MS);
		expect(withPromptCache(event, session)).not.toHaveProperty("promptCache");
	});

	it("reports nothing for a cache that never expires, or on a frame other than a reply's end", async () => {
		const codex = getBundledModel("openai-codex", "gpt-5.6-sol") as Model;
		await createSession(codex);
		expect(withPromptCache(respond(codex), session)).not.toHaveProperty("promptCache");

		const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), promptCache: { long: 3600 } } as Model;
		await createSession(model);
		const end = respond(model);
		if (end.type !== "message_end") throw new Error("expected message_end");
		expect(withPromptCache({ type: "message_start", message: end.message }, session)).not.toHaveProperty(
			"promptCache",
		);
	});
});

describe("cache_warming_stopped carries the entry warming left", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession;
	let warmer: CacheWarmer;
	let mode: "off" | "idle";
	let stopped: AgentSessionEvent[];
	const model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), promptCache: { long: 3600 } } as Model;

	beforeEach(async () => {
		vi.useFakeTimers();
		tempDir = TempDir.createSync("@scient-prompt-cache-stop-");
		const agentDir = tempDir.path();
		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		const settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		mode = "idle";
		warmer = new CacheWarmer({
			getMode: () => mode,
			getPromptTokens: () => 250_000,
			stream: async () => {
				throw new Error("no refresh expected");
			},
		});
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			cacheWarmer: warmer,
			modelRegistry: new ModelRegistry(authStorage),
			obfuscator: new SecretObfuscator([]),
		});
		stopped = [];
		session.subscribe(event => {
			if (event.type === "cache_warming_stopped") stopped.push(event);
		});
		// One main-loop request whose response wrote the prompt cache; warming is now active.
		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "long" });
		warmer.onResponse(reply(model));
	});

	afterEach(async () => {
		warmer.cancel();
		vi.useRealTimers();
		authStorage?.close();
		authStorage = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	/** Stops warming the way a setting change does, outside any refresh; returns the stop events sent. */
	async function stopWarming(): Promise<AgentSessionEvent[]> {
		mode = "off";
		warmer.onModeChanged();
		for (let tick = 0; tick < 5; tick++) await Promise.resolve();
		return stopped;
	}

	it("reports the still-warm entry once, and when warming stopped, when it stops outside a refresh", async () => {
		const sentAt = Date.now();
		vi.advanceTimersByTime(10 * 60_000);
		const [stop, ...rest] = await stopWarming();
		expect(rest).toEqual([]);
		expect(stop && withPromptCache(stop, session)).toMatchObject({
			type: "cache_warming_stopped",
			// The stop's own time: a host may read the frame much later.
			stoppedAt: sentAt + 10 * 60_000,
			promptCache: { tier: "long", touchedAt: sentAt, ttlMs: LONG_TTL_MS },
		});
		// No run is left to stop.
		warmer.onModeChanged();
		for (let tick = 0; tick < 5; tick++) await Promise.resolve();
		expect(stopped).toHaveLength(1);
	});

	it("reports no entry when the conversation changed before warming stopped", async () => {
		session.agent.state.systemPrompt = ["Changed"];
		const [stop] = await stopWarming();
		expect(stop && withPromptCache(stop, session)).not.toHaveProperty("promptCache");
	});

	it("reports no entry once the entry has expired", async () => {
		vi.advanceTimersByTime(LONG_TTL_MS);
		const [stop] = await stopWarming();
		expect(stop && withPromptCache(stop, session)).not.toHaveProperty("promptCache");
	});
});
