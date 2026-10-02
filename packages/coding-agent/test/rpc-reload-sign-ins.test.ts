import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "../src/config/model-registry";
import { reloadSignIns } from "../src/modes/rpc/reload-sign-ins";

const PROVIDER = "anthropic";
const PROVIDER_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"];

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

	it("leaves the registry as it was when nothing new was stored", async () => {
		await reloadSignIns(registry, PROVIDER);
		expect(available()).toBe(0);
	});

	it("does not throw for a provider the registry does not know", async () => {
		await reloadSignIns(registry, "no-such-provider");
		expect(available()).toBe(0);
	});
});
