import { untilAborted } from "@oh-my-pi/pi-utils";
import { MCPTransportError, type MCPTransportKind } from "../mcp/errors";
import { resolveMCPRequestDeadline } from "../mcp/timeout";
import type { MCPServerConfig } from "../mcp/types";

/** Only the in-process host can interpret a session's performance.now() value. */
export const LOCAL_TOOL_DEADLINE = "scient/toolDeadlineAt";

/** Existing MCP paths already carry the request signal through retries, setup and peer calls. */
const deadlines = new WeakMap<AbortSignal, McpToolDeadline>();

export function toolDeadline(signal?: AbortSignal): McpToolDeadline | undefined {
	return signal && deadlines.get(signal);
}

export class McpToolDeadline {
	#attemptMs: number;

	constructor(
		readonly at: number,
		limitMs: number,
		readonly transport: MCPTransportKind,
	) {
		this.#attemptMs = limitMs;
	}

	bind(signal: AbortSignal): void {
		deadlines.set(signal, this);
	}

	/** Preserve the remaining budget in a retry's timeout report without starting another timer. */
	retry(signal?: AbortSignal): void {
		this.check(signal);
		this.#attemptMs = Math.max(1, Math.ceil(this.at - performance.now()));
	}

	/** The same expiry on a later attempt, with its remaining timeout for diagnostics. */
	static remaining(at: number, transport: MCPTransportKind): McpToolDeadline {
		return new McpToolDeadline(at, Math.max(0, Math.ceil(at - performance.now())), transport);
	}

	static forCall(
		config: Pick<MCPServerConfig, "toolTimeoutMs" | "type" | "timeout"> | undefined,
		inherited?: number,
	): McpToolDeadline | undefined {
		const cap = config?.toolTimeoutMs;
		const kind = config?.type === "http" || config?.type === "sse" ? "http" : "stdio";
		if (cap === undefined) return inherited === undefined ? undefined : McpToolDeadline.remaining(inherited, kind);
		const limit = resolveMCPRequestDeadline(config?.timeout, "tools/call", undefined, cap).timeoutMs;
		return new McpToolDeadline(Math.min(inherited ?? Infinity, performance.now() + limit), limit, kind);
	}

	error(): MCPTransportError {
		const limit = this.#attemptMs;
		return new MCPTransportError({
			transport: this.transport,
			stage: "receive",
			failure: "timeout",
			message: limit > 0 ? `Request timeout after ${limit}ms` : "Tool call deadline expired",
			retryable: false,
		});
	}

	check(signal?: AbortSignal): void {
		signal?.throwIfAborted();
		if (!(performance.now() < this.at)) throw this.error();
	}

	/** Stop waiting even for work that ignores cancellation (for instance a shared credential refresh). */
	async run<T>(signal: AbortSignal | undefined, start: (bounded: AbortSignal) => Promise<T>): Promise<T> {
		this.check(signal);
		const timerAbort = new AbortController();
		const bounded = signal ? AbortSignal.any([signal, timerAbort.signal]) : timerAbort.signal;
		this.bind(bounded);
		let timer: NodeJS.Timeout | undefined;
		const arm = (): void => {
			const left = this.at - performance.now();
			if (left <= 0) timerAbort.abort(this.error());
			else timer = setTimeout(arm, Math.min(0x7fffffff, Math.ceil(left)));
		};
		arm();
		try {
			const result = await untilAborted(bounded, () => start(bounded));
			this.check(bounded);
			return result;
		} catch (error) {
			bounded.throwIfAborted();
			if (!(error instanceof MCPTransportError && error.failure === "timeout")) this.check();
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
}
