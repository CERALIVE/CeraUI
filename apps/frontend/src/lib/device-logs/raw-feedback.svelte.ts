import type { LogErrorCode } from "@ceraui/rpc/schemas";
import type { RawEnd } from "./raw-paging.svelte";
import type { RawViewDeps } from "./raw-view-rpc";

export interface RawFailure {
	readonly code: LogErrorCode;
	readonly op: "first" | RawEnd | "follow";
}

export interface RawAnnouncement {
	readonly kind:
		| "following"
		| "resumed"
		| "paused"
		| "stopped"
		| "gap"
		| "disconnected"
		| "newEntries";
	readonly count: number;
	readonly serial: number;
}

const NEW_ENTRIES_EVERY_MS = 5000;

/** The recovery band and live region for one Raw logs view. */
export class RawFeedback {
	failure = $state.raw<RawFailure | null>(null);
	announcement = $state.raw<RawAnnouncement | null>(null);
	#pendingNew = 0;
	#lastNewAt = Number.NEGATIVE_INFINITY;

	constructor(private readonly clock: Pick<RawViewDeps, "now">) {}

	announce(kind: RawAnnouncement["kind"], count = 0): void {
		const serial = (this.announcement?.serial ?? 0) + 1;
		this.announcement = { kind, count, serial };
	}

	announceNew(count: number): void {
		this.#pendingNew += count;
		const now = this.clock.now();
		if (this.#pendingNew === 0 || now - this.#lastNewAt < NEW_ENTRIES_EVERY_MS)
			return;
		this.#lastNewAt = now;
		this.announce("newEntries", this.#pendingNew);
		this.#pendingNew = 0;
	}
}
