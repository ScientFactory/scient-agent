/**
 * Reset wording that Oh My Pi's retry-hint parser does not read yet, for a host that shows when a
 * usage limit resets.
 *
 * `extractRetryHint` reads "reset at <time>" but not "resets at <time>", the wording some providers
 * use for a quota window ("429 Subscription quota exhausted. Your usage window resets at
 * 2026-11-16T12:15:34Z."). Without it such an error has no stated reset: recovery guesses its
 * 30-minute wait, and a host is told no reset time. Same grammar as upstream's `reset at` pattern, so
 * the parser treats the stamp exactly as it treats that one.
 */
export const RESETS_AT_PATTERN =
	/\bresets at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i;
