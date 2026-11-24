interface AcquireState {
	disconnected: boolean;
}

interface PendingAcquire {
	finish(): void;
	assertConnected(): void;
}

const pendingAcquires = new Map<string, Set<AcquireState>>();

/** Track a request until its working directory resolves. */
export function trackLspAcquire(connectionId: string): PendingAcquire {
	const pending = { disconnected: false };
	const acquires = pendingAcquires.get(connectionId) ?? new Set<AcquireState>();
	acquires.add(pending);
	pendingAcquires.set(connectionId, acquires);

	return {
		finish() {
			acquires.delete(pending);
			if (acquires.size === 0 && pendingAcquires.get(connectionId) === acquires) {
				pendingAcquires.delete(connectionId);
			}
		},
		assertConnected() {
			if (pending.disconnected) throw new Error("lsp acquire: client disconnected");
		},
	};
}

export function cancelLspAcquires(connectionId: string): void {
	for (const pending of pendingAcquires.get(connectionId) ?? []) pending.disconnected = true;
	pendingAcquires.delete(connectionId);
}
