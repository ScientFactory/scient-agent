/**
 * Why a turn failed, in the classifier's words, for an RPC host that reports failures.
 *
 * `promptError` already classifies the failed message with `AIError.classifyMessage` and keeps
 * only whether it is transient. A host that counts failures needs the rest: an expired sign-in,
 * a context overflow and an overloaded provider all reach it today as the same opaque error.
 * Each label names one classifier flag; together they are a closed vocabulary with no provider
 * text. `AIError.stringify` is not used: its labels skip several flags and it renders unclassified
 * ids as `status:<n>`.
 */
import * as AIError from "@oh-my-pi/pi-ai/error";

/** One label per classifier flag. A flag upstream adds fails the test until it is named here. */
export const FAILURE_KIND_LABELS: Readonly<Record<Exclude<keyof typeof AIError.Flag, "Class">, string>> = {
	ThinkingLoop: "thinking-loop",
	Transient: "transient",
	Timeout: "timeout",
	UsageLimit: "usage-limit",
	StaleResponsesItem: "stale-responses-item",
	MalformedFunctionCall: "malformed-function-call",
	ProviderFinishError: "provider-finish-error",
	EmptyResponse: "empty-response",
	ContentBlocked: "content-blocked",
	AccountPolicy: "account-policy",
	ContextOverflow: "context-overflow",
	AuthFailed: "auth-failed",
	SilentAbort: "silent-abort",
	UserInterrupt: "user-interrupt",
	Abort: "abort",
	Grammar: "grammar",
	FastModeUnsupported: "fast-mode-unsupported",
	OAuthExpiry: "oauth-expiry",
	CacheControlUnsupported: "cache-control-unsupported",
	PayloadRejected: "payload-rejected",
};

/** The labels of `errorId`'s flags, or undefined when the classifier recognized no kind. */
export function failureKinds(errorId: number): string[] | undefined {
	// An id without the class bit is a raw HTTP status, whose low bits are not flags.
	if (!AIError.is(errorId, AIError.Flag.Class)) return undefined;
	const kinds = Object.entries(FAILURE_KIND_LABELS)
		.filter(([flag]) => AIError.is(errorId, AIError.Flag[flag as keyof typeof FAILURE_KIND_LABELS]))
		.map(([, label]) => label);
	return kinds.length > 0 ? kinds : undefined;
}
