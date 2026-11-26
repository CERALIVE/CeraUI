/**
 * A device with a mutation journal, answering as `mutation-acknowledge.ts` does.
 *
 * It keeps the transitions that decide what an operator can do next: an
 * acknowledgement of an absent modem quarantines it, a quarantined modem can be kept
 * once it is back, and a decommission judges the port itself, whatever the kind.
 */
import type {
	ModemMutationAckInput,
	ModemMutationAckOutput,
	ModemMutationAckRefusal,
	ModemMutationBlock,
	ModemMutationListOutput,
} from "@ceraui/rpc/schemas";

export interface JournalEntry
	extends Pick<ModemMutationBlock, "kind" | "state"> {
	readonly present: boolean;
	/** When its state was written; a newer change on the same port has a newer one. */
	readonly updatedAt: number;
	/** A re-read shows the settings from before the change. */
	readonly matches: boolean;
	/** The list entry says Check again can work; a device that cannot says nothing. */
	readonly checkable?: boolean;
	/** The next action ends in this instead of being judged. */
	readonly fault?: ModemMutationAckRefusal;
}

const STREAM_HOLDING = new Set<ModemMutationBlock["state"]>([
	"armed",
	"executing",
	"failed",
	"device-absent-quarantine",
]);

export class MutationBlockDevice {
	replayComplete = true;
	#entries = new Map<string, JournalEntry>();

	set(stableKey: string, entry: Partial<JournalEntry> = {}): void {
		this.#entries.set(stableKey, {
			kind: "router-subnet",
			state: "failed",
			present: true,
			matches: true,
			updatedAt: 0,
			...entry,
		});
	}

	clear(stableKey: string): void {
		this.#entries.delete(stableKey);
	}

	list(): ModemMutationListOutput {
		return {
			replayComplete: this.replayComplete,
			blocks: [...this.#entries].map(([stableKey, entry]) => ({
				stableKey,
				kind: entry.kind,
				state: entry.state,
				updatedAt: entry.updatedAt,
				devicePresent: entry.present,
				blocksStreaming: STREAM_HOLDING.has(entry.state),
				...(entry.checkable === undefined
					? {}
					: { checkable: entry.checkable }),
			})),
		};
	}

	acknowledge({
		stableKey,
		mode,
	}: ModemMutationAckInput): ModemMutationAckOutput {
		const entry = this.#entries.get(stableKey);
		if (entry === undefined) return { success: false, error: "no_entry" };
		if (
			entry.state !== "failed" &&
			!(
				mode === "force-rebaseline" &&
				entry.state === "device-absent-quarantine"
			)
		)
			return { success: false, error: "not_blocked" };
		if (entry.fault !== undefined)
			return { success: false, error: entry.fault };
		if (!entry.present) {
			this.set(stableKey, { ...entry, state: "device-absent-quarantine" });
			return { success: false, error: "device_absent" };
		}
		if (mode === "verified-rollback" && !entry.matches)
			return { success: false, error: "state_mismatch" };
		this.clear(stableKey);
		return { success: true, state: "acknowledged" };
	}

	decommission(stableKey: string): ModemMutationAckOutput {
		const entry = this.#entries.get(stableKey);
		if (entry === undefined) return { success: false, error: "no_entry" };
		if (entry.state !== "failed" && entry.state !== "device-absent-quarantine")
			return { success: false, error: "not_blocked" };
		if (entry.fault !== undefined)
			return { success: false, error: entry.fault };
		if (entry.present) {
			this.set(stableKey, { ...entry, state: "failed" });
			return { success: false, error: "state_mismatch" };
		}
		this.set(stableKey, { ...entry, state: "decommissioned" });
		return { success: true, state: "decommissioned" };
	}

	rebaseline(stableKey: string): ModemMutationAckOutput {
		const entry = this.#entries.get(stableKey);
		if (entry === undefined) return { success: false, error: "no_entry" };
		if (entry.state !== "recommission-pending")
			return { success: false, error: "not_blocked" };
		if (entry.fault !== undefined)
			return { success: false, error: entry.fault };
		if (!entry.present) return { success: false, error: "device_absent" };
		this.clear(stableKey);
		return { success: true, state: "acknowledged" };
	}
}
