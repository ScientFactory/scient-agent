import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import {
	BROKER_SIGN_OUT_REFUSAL,
	listSignInProviders,
	removeStoredSignIn,
	signInStoreId,
} from "../src/modes/rpc/sign-in-providers";

const ENV = ["OPENAI_API_KEY", "DEEPSEEK_API_KEY", "OPENROUTER_API_KEY"];

describe("sign-in providers", () => {
	let dir: string;
	let auth: AuthStorage;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		for (const name of ENV) {
			saved.set(name, process.env[name]);
			delete process.env[name];
		}
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "scient-sign-in-providers-"));
		auth = await AuthStorage.create(path.join(dir, "agent.db"));
	});

	afterEach(() => {
		auth.close();
		fs.rmSync(dir, { recursive: true, force: true });
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	const entry = (id: string) => listSignInProviders(auth).find(provider => provider.id === id);

	it("tells an account sign-in from a pasted key", () => {
		expect(entry("openai-codex")?.kind).toBe("account");
		expect(entry("openai-codex-device")?.kind).toBe("account");
		expect(entry("deepseek")?.kind).toBe("key");
	});

	it("goes by what a hook-implemented sign-in asks for, not by how it is implemented", () => {
		// These hooks prompt for a pasted key or token.
		for (const id of ["xiaomi", "cloudflare-ai-gateway", "alibaba-coding-plan", "alibaba-token-plan"]) {
			expect(entry(id)?.kind, id).toBe("key");
		}
		// These run a browser, device or one-time-code flow.
		for (const id of ["github-copilot", "cursor", "perplexity", "kilo"]) {
			expect(entry(id)?.kind, id).toBe("account");
		}
	});

	it("reports nothing as signed in on a new store", () => {
		for (const id of ["openai-codex", "deepseek"]) {
			expect(entry(id)).toMatchObject({ authenticated: false, stored: false });
		}
	});

	it("reports a stored sign-in on every entry that shares its store", async () => {
		expect(signInStoreId("openai-codex-device")).toBe("openai-codex");
		await auth.credentials.set("openai-codex", {
			type: "oauth",
			access: "access-token",
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		});
		expect(entry("openai-codex")).toMatchObject({ authenticated: true, stored: true });
		expect(entry("openai-codex-device")).toMatchObject({ authenticated: true, stored: true });
		expect(entry("deepseek")).toMatchObject({ authenticated: false, stored: false });
	});

	it("tells a key from the environment from a stored one", () => {
		process.env.DEEPSEEK_API_KEY = "sk-from-the-environment";
		expect(entry("deepseek")).toMatchObject({ authenticated: true, stored: false });
	});

	it("removes a stored sign-in through either entry that shares its store", async () => {
		await auth.credentials.set("openai-codex", { type: "api_key", key: "sk-test" });
		expect(await removeStoredSignIn(auth, "openai-codex-device")).toBe(true);
		expect(entry("openai-codex")).toMatchObject({ authenticated: false, stored: false });
	});

	it("removes a sign-in another process stored after this one started", async () => {
		const otherProcess = await AuthStorage.create(path.join(dir, "agent.db"));
		try {
			await otherProcess.credentials.set("deepseek", { type: "api_key", key: "sk-test" });
			expect(await removeStoredSignIn(auth, "deepseek")).toBe(true);
			await otherProcess.credentials.reload();
			expect(otherProcess.credentials.has("deepseek")).toBe(false);
		} finally {
			otherProcess.close();
		}
	});

	it("asks the store itself, not its local copy, before and after the removal", async () => {
		await auth.credentials.set("deepseek", { type: "api_key", key: "sk-test" });
		const steps: string[] = [];
		const watched = {
			credentials: {
				revalidate: async () => {
					steps.push("revalidate");
					await auth.credentials.revalidate();
				},
				remove: async (provider: string) => {
					steps.push("remove");
					await auth.credentials.remove(provider);
				},
				has: (provider: string) => auth.credentials.has(provider),
			},
		} as unknown as Pick<AuthStorage, "credentials">;
		expect(await removeStoredSignIn(watched, "deepseek")).toBe(true);
		expect(steps).toEqual(["revalidate", "remove", "revalidate"]);
	});

	it("fails when the store still holds the sign-in after the removal", async () => {
		await auth.credentials.set("deepseek", { type: "api_key", key: "sk-test" });
		// A store whose delete does not land, as when its database is locked: the
		// in-memory copy goes, and the next read of the store brings it back.
		const stuck = {
			credentials: {
				revalidate: () => auth.credentials.revalidate(),
				remove: async () => {},
				has: (provider: string) => auth.credentials.has(provider),
			},
		} as unknown as Pick<AuthStorage, "credentials">;
		await expect(removeStoredSignIn(stuck, "deepseek")).rejects.toThrow(/could not be removed/);
		expect(entry("deepseek")).toMatchObject({ stored: true });
	});

	it("refuses to sign out when an auth broker holds the sign-ins, and lists them as not removable", async () => {
		await auth.credentials.set("deepseek", { type: "api_key", key: "sk-test" });
		// The same store, seen as a broker's snapshot.
		const credentials = new Proxy(auth.credentials, {
			get: (target, key) => {
				if (key === "heldByBroker") return true;
				const value = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const brokerHeld = { keys: auth.keys, credentials } as unknown as AuthStorage;
		expect(auth.credentials.heldByBroker).toBe(false);

		expect(listSignInProviders(brokerHeld).find(provider => provider.id === "deepseek")).toMatchObject({
			authenticated: true,
			stored: false,
		});
		await expect(removeStoredSignIn(brokerHeld, "deepseek")).rejects.toThrow(BROKER_SIGN_OUT_REFUSAL);
		expect(entry("deepseek")).toMatchObject({ authenticated: true, stored: true });
	});

	it("does nothing for an entry it does not know", async () => {
		expect(signInStoreId("no-such-provider")).toBeUndefined();
		expect(await removeStoredSignIn(auth, "no-such-provider")).toBe(false);
	});
});
