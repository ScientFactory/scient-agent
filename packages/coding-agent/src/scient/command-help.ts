/** Help for Scient's own commands; a module without side effects, so the command table can import it. */
import type { CommandMetadata } from "@oh-my-pi/pi-utils/cli";

export const dictateHelp = {
	description: "Transcribe a recording with ChatGPT's dictation, using the ChatGPT sign-in",
} satisfies CommandMetadata;
