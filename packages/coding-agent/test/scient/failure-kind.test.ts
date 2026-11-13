import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as AIError from "@oh-my-pi/pi-ai/error";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { RpcPromptResults } from "../../src/modes/rpc/rpc-prompt-results";
import type { RpcPromptResultFrame } from "../../src/modes/rpc/rpc-types";
import { AgentSession } from "../../src/session/agent-session";
import { failureKinds } from "../../src/scient/failure-kind";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const MOCK_API_SOURCE = "scient-failure-kind-test";

async function flushFrames(): Promise<void> {
	for (let hop = 0; hop < 2; hop++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

describe("prompt_result failure kinds", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@scient-usage-reset-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		unregisterCustomApis(MOCK_API_SOURCE);
		vi.restoreAllMocks();
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/** Runs one RPC prompt whose every request fails with `failure`, and returns its prompt_result. */
	async function promptResultFor(failure: string): Promise<RpcPromptResultFrame> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled Anthropic test model");
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		const mock = createMockModel({ handler: () => ({ throw: failure }) });
		const agent = new Agent({
			getApiKey: requested => `${requested.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (requested, context, options) => mock.stream(requested, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({ agent, sessionManager: SessionManager.inMemory(), settings, modelRegistry });

		const frames: RpcPromptResultFrame[] = [];
		const results = new RpcPromptResults(session, frame => frames.push(frame));
		session.subscribe(event => results.observe(event));
		const ticket = results.begin("req");
		await session.prompt("fail this turn");
		await session.waitForIdle();
		results.settle(ticket);
		await flushFrames();
		expect(frames).toHaveLength(1);
		return frames[0];
	}

	it("names the classifier's kind of a failure", async () => {
		const frame = await promptResultFor("401 Unauthorized: invalid x-api-key");

		expect(frame.status).toBe("error");
		expect(frame.error?.kinds).toEqual(["auth-failed"]);
	});

	it("names every kind the classifier gives one failure", async () => {
		const frame = await promptResultFor("429 Usage limit reached for 5 hour. retry-after-ms=3600000");

		expect(frame.error?.kinds).toEqual(["transient", "usage-limit"]);
	});

	it("leaves kinds out when the classifier recognized none", async () => {
		const frame = await promptResultFor("418 I'm a teapot");

		expect(frame.status).toBe("error");
		expect(frame.error).toBeDefined();
		expect(frame.error).not.toHaveProperty("kinds");
	});
});

describe("failure kind labels", () => {
	it("names flags the classifier's own renderer leaves out", () => {
		expect(failureKinds(AIError.create(AIError.Flag.OAuthExpiry, AIError.Flag.AuthFailed))).toEqual([
			"auth-failed",
			"oauth-expiry",
		]);
		expect(failureKinds(AIError.create(AIError.Flag.CacheControlUnsupported))).toEqual(["cache-control-unsupported"]);
	});

	it("names no kind for a raw HTTP status or a class with no flag", () => {
		expect(failureKinds(503)).toBeUndefined();
		// 0x800 is also CacheControlUnsupported's bit; without the class bit it is a status lane value.
		expect(failureKinds(0x800)).toBeUndefined();
		expect(failureKinds(AIError.create())).toBeUndefined();
	});
});
