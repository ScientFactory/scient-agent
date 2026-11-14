import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { DictationError, dictateWithChatGpt } from "../../src/scient/dictation";
import { AuthStorage } from "../../src/session/auth-storage";

const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const request = { audio, mimeType: "audio/wav", fileName: "dictation.wav" };

describe("dictation through the ChatGPT sign-in", () => {
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

	it("sends the recording with the sign-in and returns ChatGPT's text", async () => {
		await signIn();
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ text: " The p value was below 0.05. ", asset_ttl: "30d" }),
		);
		try {
			const text = await dictateWithChatGpt(authStorage, { ...request, language: "en" });
			expect(text).toBe("The p value was below 0.05.");
			const [url, init] = fetchSpy.mock.calls[0]!;
			expect(String(url)).toBe("https://chatgpt.com/backend-api/transcribe");
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer access-1");
			expect(headers.get("chatgpt-account-id")).toBe("acct-1");
			const form = init?.body as FormData;
			expect(form.get("language")).toBe("en");
			const file = form.get("file") as File;
			expect(file.name).toBe("dictation.wav");
			expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("asks for a sign-in when there is none, without uploading", async () => {
		const fetchSpy = spyOn(globalThis, "fetch");
		try {
			const error = await dictateWithChatGpt(authStorage, request).catch(e => e);
			expect(error).toBeInstanceOf(DictationError);
			expect((error as DictationError).kind).toBe("signed-out");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it.each([
		[400, "invalid-audio"],
		[429, "rate-limited"],
		[502, "unavailable"],
	] as const)("reports a %i from ChatGPT as %s", async (status, kind) => {
		await signIn();
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({ detail: "Unable to determine audio duration" }, { status }),
		);
		try {
			const error = await dictateWithChatGpt(authStorage, request).catch(e => e);
			expect((error as DictationError).kind).toBe(kind);
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
