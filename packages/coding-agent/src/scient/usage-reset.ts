/**
 * The reset time of a usage limit, for an RPC host that resumes the turn when the limit resets.
 *
 * `TurnRecovery` already learns when a usage-limited account frees up: from the provider's retry
 * hint, from the account's usage report, or from a block an earlier response stated. It keeps that
 * to itself. This file keeps the provider-stated part for the failed message, so the turn's
 * `prompt_result` can carry it. The 30-minute guess used for a hintless error with no usage report
 * is never reported: a host shows no time rather than a wrong one.
 */
import type { AssistantMessage, UsageLimitMarkResult } from "@oh-my-pi/pi-ai";

/** Recent resets; a `prompt_result` reads its message's right after recovery records it. */
const MAX_KEPT = 64;
const resets = new Map<string, number>();

/**
 * Recovery sees the `message_end` snapshot and `prompt_result` reads the message `agent_end`
 * reports: two objects for one response, so they are matched by the fields a snapshot keeps.
 */
const messageKey = (message: AssistantMessage) =>
	JSON.stringify([message.provider, message.model, message.timestamp, message.errorMessage ?? ""]);

/**
 * Remembers when a usage-limited `message`'s account resets, if the provider said so.
 * @param hintMs the delay the provider's error stated, if it stated one.
 * @param mark what marking the account blocked learned from its usage report and earlier blocks.
 */
export function recordUsageReset(
	message: AssistantMessage,
	hintMs: number | undefined,
	mark: UsageLimitMarkResult,
	now = Date.now(),
): void {
	const stated = [
		hintMs === undefined ? undefined : (mark.requestedBlockedUntilMs ?? now + hintMs),
		mark.reportResetAtMs,
		mark.priorBlockedUntilTimed === true ? mark.priorBlockedUntilMs : undefined,
	].filter((at): at is number => at !== undefined && Number.isFinite(at));
	if (stated.length === 0) return;
	const key = messageKey(message);
	resets.delete(key);
	resets.set(key, Math.round(Math.max(...stated)));
	if (resets.size > MAX_KEPT) resets.delete(resets.keys().next().value as string);
}

/** Epoch ms at which the provider said `message`'s usage limit resets. */
export function usageResetAt(message: AssistantMessage): number | undefined {
	return resets.get(messageKey(message));
}
