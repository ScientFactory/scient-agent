/**
 * The prompt-cache entry a reply confirmed, for an RPC host that compacts an idle conversation just
 * before the entry expires (Scient Desktop's "Compact idle threads"). The session already tracks
 * the entry for the status line and the cache warmer; this file puts it on the reply's `message_end`.
 *
 * Only an entry a response this process saw confirmed is reported, while the next request would
 * still read it. An inferred entry, a changed conversation and a cache that never expires report
 * nothing. The agent's own idle compaction stays a terminal feature, so the two never race.
 */
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { PromptCacheTier } from "../session/cache-warmer";

export interface RpcPromptCacheEntry {
	/** Retention tier the provider wrote the entry under: `short` (minutes) or `long` (about an hour). */
	tier: PromptCacheTier;
	/** Epoch ms when a request last wrote or read the entry: the send time, not the reply's end. */
	touchedAt: number;
	/** How long the provider keeps the entry after `touchedAt`. */
	ttlMs: number;
}

export type PromptCacheSession = Pick<AgentSession, "getPromptCacheStatus">;

/** The confirmed, still-readable entry at `nowMs`; undefined when there is none or it never expires. */
export function confirmedPromptCache(session: PromptCacheSession, nowMs = Date.now()): RpcPromptCacheEntry | undefined {
	// The token count only describes the next request; nothing here reads it.
	const status = session.getPromptCacheStatus(nowMs, 0);
	if (!status || status.inferred || status.state !== "warm" || status.ttlMs === undefined) return undefined;
	return { tier: status.tier, touchedAt: status.touchedAt, ttlMs: status.ttlMs };
}

export type PromptCacheMessageEnd = Extract<AgentSessionEvent, { type: "message_end" }> & {
	promptCache: RpcPromptCacheEntry;
};

export type PromptCacheWarmingStopped = Extract<AgentSessionEvent, { type: "cache_warming_stopped" }> & {
	promptCache: RpcPromptCacheEntry;
};

/**
 * `event`, with the confirmed entry on an assistant reply's `message_end` and on `cache_warming_stopped`:
 * a host compacts an idle conversation at that stop, while nothing keeps the entry warm any longer.
 */
export function withPromptCache(
	event: AgentSessionEvent,
	session: PromptCacheSession,
): AgentSessionEvent | PromptCacheMessageEnd | PromptCacheWarmingStopped {
	const carries =
		(event.type === "message_end" && event.message.role === "assistant") || event.type === "cache_warming_stopped";
	if (!carries) return event;
	const promptCache = confirmedPromptCache(session);
	return promptCache === undefined ? event : { ...event, promptCache };
}
