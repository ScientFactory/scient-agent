/**
 * `scient-agent dictate <file>`: the text of a recording, from ChatGPT's dictation with the stored
 * ChatGPT sign-in. With --json it prints `{ "text": ... }`, or `{ "error": { "kind", "message" } }`
 * and exits 1, for a host that turns a failure into its own message.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import { dictateHelp } from "./command-help";
import { DICTATION_MAX_BYTES, DictationError, dictateWithChatGpt, dictationAudioType } from "./dictation";

export default class Dictate extends Command {
	static description = dictateHelp.description;
	static args = {
		file: Args.string({ description: "Recording to transcribe (wav, webm, m4a, mp3 or ogg)", required: true }),
	};
	static flags = {
		language: Flags.string({
			char: "l",
			description: "Language of the speech, as an ISO 639-1 code (default: detect)",
		}),
		json: Flags.boolean({ description: "Print one JSON document" }),
	};
	static examples = ["scient-agent dictate note.wav", "scient-agent dictate note.wav --language he --json"];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Dictate);
		const report = (result: { text: string } | { error: { kind: string; message: string } }) => {
			if (flags.json) process.stdout.write(`${JSON.stringify(result)}\n`);
			else if ("text" in result) process.stdout.write(`${result.text}\n`);
			else process.stderr.write(`error: ${result.error.message}\n`);
			if ("error" in result) process.exitCode = 1;
		};
		const file = args.file as string;
		const mimeType = dictationAudioType(file);
		if (!mimeType) {
			report({ error: { kind: "invalid-audio", message: "Use a wav, webm, m4a, mp3 or ogg recording." } });
			return;
		}
		if (flags.language !== undefined && !/^[a-z]{2}$/.test(flags.language)) {
			report({ error: { kind: "invalid-audio", message: "Give the language as a two-letter code, such as en." } });
			return;
		}
		const size = await fs.stat(file).then(
			stat => (stat.isFile() ? stat.size : undefined),
			() => undefined,
		);
		if (size === undefined || size > DICTATION_MAX_BYTES) {
			report({ error: { kind: "invalid-audio", message: "The recording is missing or too large." } });
			return;
		}
		const settings = await Settings.loadReadOnly();
		const authStorage = await discoverAuthStorage(undefined, { settings });
		try {
			const text = await dictateWithChatGpt(authStorage, {
				audio: new Uint8Array(await fs.readFile(file)),
				mimeType,
				fileName: path.basename(file),
				...(flags.language ? { language: flags.language } : {}),
			});
			report({ text });
		} catch (error) {
			const kind = error instanceof DictationError ? error.kind : "unavailable";
			const message = error instanceof DictationError ? error.message : "Dictation failed.";
			report({ error: { kind, message } });
		} finally {
			authStorage.close();
		}
	}
}
