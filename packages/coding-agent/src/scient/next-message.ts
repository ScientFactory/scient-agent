/**
 * `predict_next_message` for RPC hosts: Oh My Pi's composer prediction, asked for by the host.
 *
 * The TUI's `ComposerPredictionController` runs it after every turn and shows the result as ghost
 * text. A host has its own composer and its own switch, so it asks once a turn has completed and
 * shows the message itself. The prompt and the reply parsing are Oh My Pi's; this file only runs
 * them the way the controller does: an ephemeral side turn on the session's model and context (so it
 * reads the prompt cache), at the lowest effort where that keeps the cache, recorded in the
 * session's usage. The session's history is not changed.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { parseComposerPrediction } from "../modes/controllers/composer-prediction-controller";
import composerPredictionPrompt from "../prompts/system/composer-prediction-user.md" with { type: "text" };
import type { AgentSession } from "../session/agent-session";
import { isAdvisorCard } from "../session/queued-messages";

/** The reply Oh My Pi's prediction prompt asks for without a confident guess; its parser drops it. */
export const SKIP_REPLY = "NO_PREDICTION";
/** Oh My Pi's output cap for the prediction, sent only where it leaves the cached request unchanged. */
const MAX_TOKENS = 1024;
/** A prediction that has not arrived by then is no longer worth paying for or showing. */
const DEADLINE_MS = 15_000;
/** The usage-ledger purpose Oh My Pi's composer predictions record under. */
const USAGE_PURPOSE = "composer-prediction";

type PredictionSession = Pick<
	AgentSession,
	| "model"
	| "messages"
	| "isStreaming"
	| "isCompacting"
	| "sessionManager"
	| "runEphemeralTurn"
	| "ephemeralMaxTokensPreservesRequest"
>;

/** The message the prediction answers: the last one that is not a silent advisor card. */
function anchor(session: PredictionSession): AgentMessage | undefined {
	const messages = session.messages;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (!isAdvisorCard(messages[i])) return messages[i];
	}
	return undefined;
}

/** One prediction per RPC session at a time; a newer request replaces the one in flight. */
export class RpcNextMessagePredictor {
	readonly #session: PredictionSession;
	readonly #deadlineMs: number;
	#abort: AbortController | undefined;

	constructor(session: PredictionSession, options: { deadlineMs?: number } = {}) {
		this.#session = session;
		this.#deadlineMs = options.deadlineMs ?? DEADLINE_MS;
	}

	/**
	 * The user's likely next message, or `null` when there is no confident guess, no model, a turn or
	 * compaction is running, the conversation moved on, the deadline passed, or a newer request
	 * replaced this one. Rejects when the model request itself fails.
	 */
	async predict(): Promise<string | null> {
		this.#abort?.abort();
		this.#abort = undefined;
		const session = this.#session;
		if (!session.model || session.isStreaming || session.isCompacting) return null;
		const abort = new AbortController();
		this.#abort = abort;
		const deadline = AbortSignal.timeout(this.#deadlineMs);
		const lastMessage = anchor(session);
		// The journal id the usage ledger accepts, and the entry the side turn branched from.
		const owner = { sessionId: session.sessionManager.getSessionId(), parentId: session.sessionManager.getLeafId() };
		try {
			const { replyText, assistantMessage } = await session.runEphemeralTurn({
				promptText: prompt.render(composerPredictionPrompt, { skip: SKIP_REPLY }),
				maxTokens: session.ephemeralMaxTokensPreservesRequest() ? MAX_TOKENS : undefined,
				minimizeEffort: true,
				signal: AbortSignal.any([abort.signal, deadline]),
			});
			// Paid for even when it is no longer wanted.
			this.#recordUsage(owner, assistantMessage);
			if (abort.signal.aborted || anchor(session) !== lastMessage) return null;
			return parseComposerPrediction(replyText) ?? null;
		} catch (error) {
			if (abort.signal.aborted || deadline.aborted) return null;
			throw error;
		} finally {
			if (this.#abort === abort) this.#abort = undefined;
		}
	}

	#recordUsage(owner: { sessionId: string; parentId: string | null }, message: AssistantMessage): void {
		try {
			this.#session.sessionManager.appendModelUsage(
				{
					purpose: USAGE_PURPOSE,
					api: message.api,
					provider: message.provider,
					model: message.model,
					usage: message.usage,
					stopReason: message.stopReason,
				},
				owner,
			);
		} catch (error) {
			logger.debug("Failed to persist next-message prediction usage", { error: String(error) });
		}
	}
}
