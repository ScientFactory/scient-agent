/**
 * Dictation through the ChatGPT sign-in. A recording goes to ChatGPT's own transcription service,
 * the one the ChatGPT and Codex apps dictate with, and its text comes back. The stored credential
 * is refreshed or rotated by the shared OAuth retry, as for a model request.
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
const TRANSCRIBE_URL = `${CODEX_BASE_URL}/transcribe`;
const ORIGINATOR = "Codex Desktop";
/** Far above a long dictation; it keeps a wrong file from being uploaded whole. */
export const DICTATION_MAX_BYTES = 25 * 1024 * 1024;

export type DictationFailureKind =
	/** No ChatGPT sign-in, or ChatGPT refused it after a refresh. */
	| "signed-out"
	/** The recording is too short or not audio ChatGPT can read. */
	| "invalid-audio"
	| "rate-limited"
	| "unavailable";

export class DictationError extends Error {
	override readonly name = "DictationError";
	constructor(
		readonly kind: DictationFailureKind,
		message: string,
	) {
		super(message);
	}
}

export interface DictationRequest {
	readonly audio: Uint8Array;
	readonly mimeType: string;
	readonly fileName: string;
	/** An ISO 639-1 code; ChatGPT detects the language without one. */
	readonly language?: string;
	readonly signal?: AbortSignal;
}

const AUDIO_TYPES: Readonly<Record<string, string>> = {
	wav: "audio/wav",
	webm: "audio/webm",
	m4a: "audio/mp4",
	mp4: "audio/mp4",
	mp3: "audio/mpeg",
	ogg: "audio/ogg",
};

/** The audio type of a recording file by its extension, or undefined for a file ChatGPT does not read. */
export function dictationAudioType(fileName: string): string | undefined {
	const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
	return AUDIO_TYPES[extension];
}

function failure(status: number, body: string): DictationError {
	if (status === 400 || status === 413 || status === 415)
		return new DictationError("invalid-audio", "ChatGPT could not read this recording.");
	if (status === 401 || status === 403)
		return new DictationError("signed-out", "ChatGPT refused the sign-in. Sign in to ChatGPT again.");
	if (status === 429) return new DictationError("rate-limited", "ChatGPT is limiting dictation. Try again soon.");
	return new DictationError("unavailable", `ChatGPT dictation failed (${status})${body ? `: ${body}` : ""}`);
}

async function transcribe(request: DictationRequest, accessToken: string, accountId: string | undefined) {
	const form = new FormData();
	form.append("file", new File([request.audio], request.fileName, { type: request.mimeType }));
	if (request.language) form.append("language", request.language);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${accessToken}`,
		"User-Agent": `${ORIGINATOR}/${CODEX_CLIENT_VERSION}`,
		[OPENAI_HEADERS.ORIGINATOR]: ORIGINATOR,
		[OPENAI_HEADERS.VERSION]: CODEX_CLIENT_VERSION,
	};
	if (accountId) headers[OPENAI_HEADERS.ACCOUNT_ID] = accountId;
	const response = await wrapFetchForProxy(fetch, PROVIDER)(TRANSCRIBE_URL, {
		method: "POST",
		headers,
		body: form,
		signal: request.signal,
	});
	if (!response.ok) {
		const body = (await response.text().catch(() => "")).trim().replaceAll(/\s+/g, " ").slice(0, 300);
		// The shared retry reads the status: a 401 refreshes the credential once before failing.
		throw new ProviderHttpError(body || response.statusText, response.status);
	}
	const payload: unknown = await response.json().catch(() => undefined);
	const text = (payload as { text?: unknown } | undefined)?.text;
	if (typeof text !== "string") throw new DictationError("unavailable", "ChatGPT returned no transcript.");
	return text.trim();
}

/** Transcribes one recording with the stored ChatGPT sign-in. */
export async function dictateWithChatGpt(storage: AuthStorage, request: DictationRequest): Promise<string> {
	if (request.audio.byteLength === 0) throw new DictationError("invalid-audio", "The recording is empty.");
	if (request.audio.byteLength > DICTATION_MAX_BYTES)
		throw new DictationError("invalid-audio", "The recording is too large to dictate.");
	try {
		return await withOAuthAccess(
			storage,
			PROVIDER,
			access => transcribe(request, access.accessToken, access.accountId ?? getCodexAccountId(access.accessToken)),
			{ signal: request.signal, missingAccessMessage: "Sign in to ChatGPT to dictate." },
		);
	} catch (error) {
		if (error instanceof DictationError) throw error;
		if (error instanceof MissingApiKeyError) throw new DictationError("signed-out", "Sign in to ChatGPT to dictate.");
		if (error instanceof ProviderHttpError) throw failure(error.status, error.message);
		if (request.signal?.aborted) throw error;
		throw new DictationError("unavailable", "Scient Agent could not reach ChatGPT.");
	}
}
