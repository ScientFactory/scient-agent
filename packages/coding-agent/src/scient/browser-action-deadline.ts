import type { AsyncLocalStorage } from "node:async_hooks";
import { AbortError, untilAborted } from "@oh-my-pi/pi-utils/abortable";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { ToolAbortError } from "../tools/tool-errors";
import { TernError } from "../tools/browser/tern/wire";

interface NativeTargetDeadline {
	assertActive(): void;
	requestTimeoutMs: number;
	quickRead: boolean;
	report?: (elapsedMs: number) => Error | undefined;
}

interface NativeTargetReadScope {
	deadline: number;
	signal: AbortSignal;
	nativeTargetDeadline?: NativeTargetDeadline;
}

export function assertNativeTargetDeadline(scope: NativeTargetReadScope | undefined): void {
	scope?.nativeTargetDeadline?.assertActive();
}

export function nativeTargetRequestTimeout(
	scope: NativeTargetReadScope | undefined,
	requested: number | undefined,
	fallback: number,
): number {
	const target = scope?.nativeTargetDeadline;
	if (!target) return fallback;
	target.assertActive();
	// The enclosing signal owns expiry; a fresh remaining-time timer would race it.
	return Math.min(requested ?? Infinity, target.requestTimeoutMs);
}

export function isQuickReadDeadline(scope: NativeTargetReadScope | undefined): boolean {
	return scope !== undefined && (scope.nativeTargetDeadline?.quickRead ?? true);
}

export function setNativeTargetTimeout(
	scope: NativeTargetReadScope | undefined,
	report: (elapsedMs: number) => Error | undefined,
): void {
	if (!scope?.nativeTargetDeadline) throw new Error("Native target resolution requires a deadline scope");
	scope.nativeTargetDeadline.report = report;
}

/** One absolute deadline covers selector preparation, every native read, scrolling, and retry waits. */
export async function withNativeTargetDeadline<T>(
	storage: AsyncLocalStorage<NativeTargetReadScope>,
	label: string,
	timeoutMs: number,
	parent: AbortSignal | undefined,
	run: () => Promise<T>,
): Promise<T> {
	parent?.throwIfAborted();
	const started = Date.now();
	const outer = storage.getStore();
	const deadline = Math.min(started + timeoutMs, outer?.deadline ?? Infinity);
	const controller = new AbortController();
	const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
	const target: NativeTargetDeadline = {
		assertActive() {
			parent?.throwIfAborted();
			signal.throwIfAborted();
			if (Date.now() >= deadline) throw expire();
		},
		requestTimeoutMs: Math.max(1, deadline - started),
		quickRead: isQuickReadDeadline(outer),
	};
	const expire = (): unknown => {
		if (!controller.signal.aborted) {
			const elapsed = Date.now() - started;
			controller.abort(target.report?.(elapsed) ?? new ToolError(`${label} timed out after ${elapsed}ms`));
		}
		return controller.signal.reason;
	};
	const timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
	try {
		target.assertActive();
		const result = await storage.run({ deadline, signal, nativeTargetDeadline: target }, () =>
			untilAborted(signal, run),
		);
		target.assertActive();
		return result;
	} catch (error) {
		parent?.throwIfAborted();
		if (
			controller.signal.aborted &&
			(error === controller.signal.reason ||
				(error instanceof AbortError && error.cause === controller.signal.reason))
		) {
			throw controller.signal.reason;
		}
		if (error instanceof TernError && error.kind === "timeout" && Date.now() >= deadline) throw expire();
		throw error;
	} finally {
		clearTimeout(timer);
		controller.abort(new ToolAbortError("Native target resolution ended"));
	}
}
