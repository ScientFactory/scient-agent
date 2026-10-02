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

/** An extension provider whose real catalog comes from its sign-in: the
 * registered model is a placeholder, and the hook swaps in what the account
 * has. It has no discovery of its own. */
const EXTENSION_PROVIDER = "reload-sign-ins-provider";
const extensionProviderConfig = (): ProviderConfigInput => ({
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
			...models.filter(model => model.provider !== EXTENSION_PROVIDER),
			{
				...(models.find(model => model.provider === EXTENSION_PROVIDER) as Model<Api>),
				id: "from-the-account",
				name: "From the account",
			},
		],
	},
});

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
		// static configuration, so a reload of the static models drops it.
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
		const cacheId = resolveModelCacheProviderId(other, { apiKey: otherKey });
		writeModelCache(cacheId, Date.now(), [discovered], true, "", path.join(dir, "models.db"));
		await registry.hydrateCredentialScopedModelCaches();
		const hasDiscovered = () =>
			registry.getAvailable().some(model => model.provider === other && model.id === discovered.id);
		expect(hasDiscovered()).toBe(true);
		// Empty the cache row, as for a catalog that exists only in this session:
		// a reload that discards it could not read it back.
		writeModelCache(cacheId, Date.now(), [], true, "", path.join(dir, "models.db"));

		await otherProcess.credentials.set(PROVIDER, { type: "api_key", key: "sk-test" });
		await reloadSignIns(registry, PROVIDER);

		expect(available()).toBeGreaterThan(0);
		expect(hasDiscovered()).toBe(true);
	});

	const signInElsewhere = () =>
		otherProcess.credentials.set(EXTENSION_PROVIDER, {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
	const extensionModels = () =>
		registry
			.getAvailable()
			.filter(model => model.provider === EXTENSION_PROVIDER)
			.map(model => model.id);

	it.each([
		["no models file", false],
		["an unchanged models file", true],
	] as const)(
		"applies an extension provider's sign-in hook for a sign-in stored afterwards, with %s",
		async (_label, modelsFile) => {
			if (modelsFile) {
				// An unchanged file makes the registry skip its static reload, so the
				// hook cannot depend on one.
				fs.writeFileSync(path.join(dir, "models.yaml"), "providers: {}\n");
				registry = new ModelRegistry(session, path.join(dir, "models.yaml"));
			}
			registry.registerProvider(EXTENSION_PROVIDER, extensionProviderConfig(), EXTENSION);
			expect(extensionModels()).toEqual([]);

			await signInElsewhere();
			await reloadSignIns(registry, EXTENSION_PROVIDER);

			expect(extensionModels()).toEqual(["from-the-account"]);
		},
	);

	it("applies that hook when the registry had gone back to composing lazily", async () => {
		registry.registerProvider(EXTENSION_PROVIDER, extensionProviderConfig(), EXTENSION);
		// A refresh with no models file leaves the registry without a full
		// snapshot; a lookup then caches the placeholder for this provider.
		await registry.refresh("offline");
		expect(registry.find(EXTENSION_PROVIDER, "placeholder")).toBeDefined();

		await signInElsewhere();
		await reloadSignIns(registry, EXTENSION_PROVIDER);

		expect(registry.find(EXTENSION_PROVIDER, "from-the-account")).toBeDefined();
		expect(registry.find(EXTENSION_PROVIDER, "placeholder")).toBeUndefined();
		expect(extensionModels()).toEqual(["from-the-account"]);
	});

	/** An extension provider that lists its models by asking its service. */
	const listedModel = {
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8192,
	};
	const registerDiscoveringProvider = (provider: string, fetches: { count: number }, bundled = false) =>
		registry.registerProvider(
			provider,
			{
				baseUrl: "https://example.invalid/v1",
				apiKey: "RELOAD_SIGN_INS_UNSET_KEY",
				api: "openai-completions",
				...(bundled ? { models: [{ ...listedModel, id: "bundled", name: "Bundled" }] } : {}),
				fetchDynamicModels: async () => {
					fetches.count++;
					return [{ ...listedModel, id: "listed-by-the-service", name: "Listed by the service" }];
				},
			},
			EXTENSION,
		);
	const usable = (provider: string) =>
		registry
			.getAvailable()
			.filter(model => model.provider === provider)
			.map(model => model.id);

	it("discovers a provider this session never discovered, even when it has bundled models", async () => {
		const provider = "reload-sign-ins-bundled";
		const fetches = { count: 0 };
		registerDiscoveringProvider(provider, fetches, true);
		// The sign-in is already in this session's memory (the store adopts
		// outside changes whenever a credential is resolved), so the bundled model
		// is usable, but the account's own catalog was never fetched.
		session.keys.setRuntime(provider, "sk-runtime");
		expect(usable(provider)).toEqual(["bundled"]);

		await reloadSignIns(registry, provider);

		expect(fetches.count).toBe(1);
		expect(usable(provider).toSorted()).toEqual(["bundled", "listed-by-the-service"]);
	});

	it("rediscovers a provider that had no usable model", async () => {
		const provider = "reload-sign-ins-discovering";
		const fetches = { count: 0 };
		registerDiscoveringProvider(provider, fetches);
		expect(usable(provider)).toEqual([]);

		await otherProcess.credentials.set(provider, { type: "api_key", key: "sk-test" });
		await reloadSignIns(registry, provider);

		expect(fetches.count).toBe(1);
		expect(usable(provider)).toEqual(["listed-by-the-service"]);
	});

	it("does not rediscover a provider whose catalog this session already discovered", async () => {
		const provider = "reload-sign-ins-working";
		const fetches = { count: 0 };
		registerDiscoveringProvider(provider, fetches);
		session.keys.setRuntime(provider, "sk-runtime");
		await registry.refreshRuntimeProviders("online");
		expect(fetches.count).toBe(1);
		expect(usable(provider)).toEqual(["listed-by-the-service"]);

		// A model this provider does not have: a failed rediscovery could replace
		// its models with a partial cached list, so none is attempted.
		await reloadSignIns(registry, provider);

		expect(fetches.count).toBe(1);
		expect(usable(provider)).toEqual(["listed-by-the-service"]);
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
