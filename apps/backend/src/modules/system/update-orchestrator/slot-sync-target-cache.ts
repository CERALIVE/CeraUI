import type { RootSlotStatus } from "./slot-status.ts";
import {
	judgeMirrorTarget,
	type MirrorTargetVerdict,
	type SlotSyncEvidence,
} from "./slot-sync-gate.ts";

export const SLOT_SYNC_TARGET_REFRESH_MS = 60_000;

/** Gate-only evidence: coalesce both preflights and throttle failures as well as
 * successes. Completion still reads RAUC freshly, outside this cache. */
export class SlotSyncTargetCache {
	private cached:
		| {
				readonly key: string;
				readonly startedAt: number;
				readonly verdict: Promise<MirrorTargetVerdict>;
		  }
		| undefined;

	reset(): void {
		this.cached = undefined;
	}

	read(
		evidence: SlotSyncEvidence,
		deps: {
			readonly now: () => number;
			readonly readRootSlots: () => Promise<readonly RootSlotStatus[]>;
		},
	): Promise<MirrorTargetVerdict> {
		const key = JSON.stringify([
			evidence.bootId,
			evidence.healthyState?.slot,
			evidence.receiptTargetSlot,
		]);
		const startedAt = deps.now();
		const age = this.cached ? startedAt - this.cached.startedAt : -1;
		if (
			this.cached?.key === key &&
			age >= 0 &&
			age < SLOT_SYNC_TARGET_REFRESH_MS
		)
			return this.cached.verdict;
		const verdict = deps.readRootSlots().then(
			(slots): MirrorTargetVerdict => {
				const booted = slots.find((slot) => slot.state === "booted");
				if (
					booted?.bootStatus !== "good" ||
					(evidence.healthyState?.slot !== booted.name &&
						evidence.healthyState?.slot !== booted.bootname)
				)
					return "undecidable";
				return judgeMirrorTarget(slots, evidence.receiptTargetSlot);
			},
			(): MirrorTargetVerdict => "undecidable",
		);
		this.cached = { key, startedAt, verdict };
		return verdict;
	}
}
