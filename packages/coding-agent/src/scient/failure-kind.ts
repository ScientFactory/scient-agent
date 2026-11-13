/**
 * Why a turn failed, in the classifier's words, for an RPC host that reports failures.
 *
 * `promptError` already classifies the failed message with `AIError.classifyMessage` and keeps
 * only whether it is transient. A host that counts failures needs the rest: an expired sign-in,
 * a context overflow and an overloaded provider all reach it today as the same opaque error.
 * Each label names one classifier flag, and `network` marks a failure that never reached the
 * provider; together they are a closed vocabulary with no provider text. `AIError.stringify` is
 * not used: its labels skip several flags and it renders unclassified ids as `status:<n>`.
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

/**
 * The label of a failure to reach the provider at all: no DNS answer, a refused connection, no
 * network, a certificate that did not verify. The classifier marks these only `transient`, like a
 * provider's own outage; a host tells the two apart by this label. It is Oh My Pi's network
 * diagnosis (`classifyNetworkCause`), not a classifier flag.
 */
export const NETWORK_FAILURE_KIND = "network";

/**
 * The sentences Oh My Pi's `networkFailureMessage` writes for a failed connection. The refused one
 * keeps no error code, so the diagnosis does not recognize it again from the text.
 */
const NETWORK_FAILURE_SENTENCE =
	/\b(?:No internet connection: couldn't reach |Couldn't reach .+?(?: \(|\. Check the URL)|Couldn't connect to .+? \(connection refused\)|TLS certificate verification failed for )/;

/** Whether a failure with this text never reached the provider: it has no HTTP status and reads as a transport failure. */
function isNetworkFailure(failure: { errorMessage?: string; errorStatus?: number } | undefined): boolean {
	const text = failure?.errorMessage;
	if (!text || failure?.errorStatus !== undefined || AIError.status({ message: text }) !== undefined) return false;
	if (NETWORK_FAILURE_SENTENCE.test(text)) return true;
	const cause = AIError.classifyNetworkCause(text);
	// A bare "unable to verify" may be about a token, not a certificate.
	return cause !== undefined && (cause.kind !== "tls" || /certificat/i.test(text));
}

/**
 * The labels of `errorId`'s flags, plus {@link NETWORK_FAILURE_KIND} when `failure` never reached
 * the provider, or undefined when no kind is recognized.
 */
export function failureKinds(
	errorId: number,
	failure?: { errorMessage?: string; errorStatus?: number },
): string[] | undefined {
	// An id without the class bit is a raw HTTP status, whose low bits are not flags.
	const kinds = AIError.is(errorId, AIError.Flag.Class)
		? Object.entries(FAILURE_KIND_LABELS)
				.filter(([flag]) => AIError.is(errorId, AIError.Flag[flag as keyof typeof FAILURE_KIND_LABELS]))
				.map(([, label]) => label)
		: [];
	if (isNetworkFailure(failure)) kinds.push(NETWORK_FAILURE_KIND);
	return kinds.length > 0 ? kinds : undefined;
}
