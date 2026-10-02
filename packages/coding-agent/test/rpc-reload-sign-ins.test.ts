import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type Api, type AssistantMessageEventStream, AuthStorage, clearCustomApis, type Model } from "@oh-my-pi/pi-ai";
import { unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveModelCacheProviderId } from "@oh-my-pi/pi-catalog/provider-models";
import { ModelRegistry, type ProviderConfigInput } from "../src/config/model-registry";
import { reloadSignIns } from "../src/modes/rpc/reload-sign-ins";

const PROVIDER = "anthropic";
const PROVIDER_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"];
const EXTENSION = "ext://reload-sign-ins";

describe("reloadSignIns", () => {
	let dir: string;
	let session: AuthStorage;
	let otherProcess: AuthStorage;
	let registry: ModelRegistry;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const name of PROVIDER_ENV) {
			saved.set(name, process.env[name]);
			delete process.env[name];
		}
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "scient-reload-sign-ins-"));
		const store = path.join(dir, "agent.db");
		// Two handles on one store: this session's, and the one another process
		// (a terminal `login`) writes through.
		session = await AuthStorage.create(store);
		otherProcess = await AuthStorage.create(store);
		registry = new ModelRegistry(session, path.join(dir, "models.yaml"));
	});

	afterEach(() => {
		clearCustomApis();
		unregisterOAuthProviders(EXTENSION);
		session.close();
		otherProcess.close();
		fs.rmSync(dir, { recursive: true, force: true });
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	const available = () => registry.getAvailable().filter(model => model.provider === PROVIDER).length;

	it("finds the models of a sign-in stored after the session started", async () => {
		expect(available()).toBe(0);
		await otherProcess.credentials.set(PROVIDER, { type: "api_key", key: "sk-test" });
		// The session read its sign-ins at startup, so it still sees none.
		expect(available()).toBe(0);

		await reloadSignIns(registry, PROVIDER);

		expect(available()).toBeGreaterThan(0);
	});

	it("keeps the models another provider discovered", async () => {
		// A catalog that exists only for the signed-in account: it is not in the
		// static configuration, so a reload of the static models would drop it.
		const other = "opencode-go";
		const otherKey = "opencode-go-test-key";
		const discovered = buildModel({
			id: "discovered-for-this-account",
			name: "Discovered for this account",
			api: "openai-responses",
			provider: other,
			baseUrl: "https://opencode.ai/zen/go/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
		session.keys.setRuntime(other, otherKey);
		writeModelCache(
			resolveModelCacheProviderId(other, { apiKey: otherKey }),
			Date.now(),
			[discovered],
			true,
			"",
			path.join(dir, "models.db"),
		);
		await registry.hydrateCredentialScopedModelCaches();
		const hasDiscovered = () =>
			registry.getAvailable().some(model => model.provider === other && model.id === discovered.id);
		expect(hasDiscovered()).toBe(true);

		await otherProcess.credentials.set(PROVIDER, { type: "api_key", key: "sk-test" });
		await reloadSignIns(registry, PROVIDER);

		expect(available()).toBeGreaterThan(0);
		expect(hasDiscovered()).toBe(true);
	});

	it("applies an extension provider's sign-in hook for a sign-in stored afterwards", async () => {
		// An extension provider whose real catalog comes from its sign-in: the
		// registered model is a placeholder, and the hook swaps in what the account
		// has. It has no discovery of its own, so only a recomposition runs the hook.
		const extensionProvider = "reload-sign-ins-provider";
		const config: ProviderConfigInput = {
			api: "reload-sign-ins-api",
			baseUrl: "https://example.invalid/",
			streamSimple: () => ({}) as unknown as AssistantMessageEventStream,
			models: [
				{
					id: "placeholder",
					name: "Placeholder",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 8192,
				},
			],
			oauth: {
				name: "Reload sign-ins",
				login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 60_000 }),
				refreshToken: async credentials => credentials,
				getApiKey: credentials => credentials.access,
				modifyModels: models => [
					...models.filter(model => model.provider !== extensionProvider),
					{
						...(models.find(model => model.provider === extensionProvider) as Model<Api>),
						id: "from-the-account",
						name: "From the account",
					},
				],
			},
		};
		registry.registerProvider(extensionProvider, config, EXTENSION);
		const ids = () =>
			registry
				.getAvailable()
				.filter(model => model.provider === extensionProvider)
				.map(model => model.id);
		expect(ids()).toEqual([]);

		await otherProcess.credentials.set(extensionProvider, {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		await reloadSignIns(registry, extensionProvider);

		expect(ids()).toEqual(["from-the-account"]);
	});

	it("leaves the registry as it was when nothing new was stored", async () => {
		await reloadSignIns(registry, PROVIDER);
		expect(available()).toBe(0);
	});

	it("does not throw for a provider the registry does not know", async () => {
		await reloadSignIns(registry, "no-such-provider");
		expect(available()).toBe(0);
	});
});
