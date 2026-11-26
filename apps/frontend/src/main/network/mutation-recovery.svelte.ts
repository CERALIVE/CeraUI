/**
 * A modem change the device could not confirm, and the operator's way out of it.
 *
 * The device's list is the only authority for what is blocked. It is a pull and
 * nothing is pushed when a block appears or clears, so `NetworkView` re-reads it
 * on the device's own events and every action re-reads it too. Nothing polls.
 */
import type {
	Modem,
	ModemMutationAckOutput,
	ModemMutationBlock,
	ModemMutationKind,
	ModemMutationListOutput,
	ModemMutationState,
} from "@ceraui/rpc/schemas";
import { portLabelFromIdPath } from "@ceraui/rpc/schemas";

import {
	loadWithinBound,
	type ModemAsyncSurfaceId,
} from "$lib/modem/async-surface";
import type { MutationOutcomeKind } from "$lib/modem/mutation-outcome";
import { rpc } from "$lib/rpc/client";
import { getLinkEpoch } from "$lib/rpc/session-epoch.svelte";

export type RecoveryAction = "check" | "keep" | "gone";

export interface RecoveryOutcome {
	readonly kind: MutationOutcomeKind;
	readonly messageKey: string;
}

/** An answer, and the block as it stood then: it does not outlive that state. */
interface HeldOutcome extends RecoveryOutcome {
	readonly about: ModemMutationBlock | undefined;
}

export interface RecoveryNotice {
	readonly stableKey: string;
	/** Absent once settled, while the outcome of the last action is still shown. */
	readonly block?: ModemMutationBlock;
	readonly outcome?: RecoveryOutcome;
}

export interface PlacedNotices {
	readonly byRow: ReadonlyMap<string, RecoveryNotice>;
	readonly unlisted: readonly RecoveryNotice[];
}

/** What each state says and offers. A state not named here is not a block. */
const VIEW: Partial<
	Record<
		ModemMutationState,
		{ bodyKey: string; actions: readonly RecoveryAction[] }
	>
> = {
	failed: {
		bodyKey: "network.block.failed",
		actions: ["check", "keep", "gone"],
	},
	"device-absent-quarantine": {
		bodyKey: "network.block.absent",
		actions: ["keep", "gone"],
	},
	"recommission-pending": {
		bodyKey: "network.block.returned",
		actions: ["keep"],
	},
	decommissioned: { bodyKey: "network.block.retired", actions: [] },
};

const CHANGE_KEY: Partial<Record<ModemMutationKind, string>> = {
	"usb-mode": "network.modem.usbMode.title",
	"band-lock": "network.modem.bands.title",
	"five-g-pref": "network.modem.fiveG.title",
	"fcc-unlock": "network.modem.fccUnlock.title",
	"modem-config": "network.modem.configuration",
	"router-subnet": "network.routerCellular.subnet.addressLabel",
};

export function recoveryView(block: ModemMutationBlock) {
	return VIEW[block.state];
}

/** The device says, per entry, whether a check can work; silence means it cannot. */
export function offeredActions(
	block: ModemMutationBlock,
): readonly RecoveryAction[] {
	return (recoveryView(block)?.actions ?? []).filter(
		(action) => action !== "check" || block.checkable === true,
	);
}

export function changeLabelKey(block: ModemMutationBlock): string | undefined {
	return CHANGE_KEY[block.kind];
}

/** Where a modem with no row is. The USB label alone repeats across controllers. */
export function portLabel(stableKey: string): string {
	return portLabelFromIdPath(stableKey, "port-and-controller") ?? stableKey;
}

export function goneLabelKey(block: ModemMutationBlock): string {
	return block.kind === "router-subnet" || block.kind === "router-admin"
		? "network.block.goneDongle"
		: "network.block.goneModem";
}

/** Nothing is left to decide: the entry is gone, or the port was let go. */
function isSettled(block: ModemMutationBlock | undefined): boolean {
	return block === undefined || block.state === "decommissioned";
}

function isUnchanged(
	then: ModemMutationBlock | undefined,
	now: ModemMutationBlock | undefined,
): boolean {
	return (
		(isSettled(then) && isSettled(now)) ||
		(then?.state === now?.state && then?.updatedAt === now?.updatedAt)
	);
}

interface Reply {
	readonly answer?: ModemMutationAckOutput;
	/** The call that outlived its bound: the device may still answer it. */
	readonly late?: Promise<unknown>;
}

async function withinBound(
	surface: ModemAsyncSurfaceId,
	run: () => Promise<ModemMutationAckOutput>,
): Promise<Reply> {
	let call: Promise<ModemMutationAckOutput> | undefined;
	const reply = await loadWithinBound(surface, () => {
		call = run();
		return call;
	});
	if (reply.phase === "loaded") return { answer: reply.value };
	return reply.phase === "timed-out" ? { late: call } : {};
}

/** One press is one call, so the answer shown is the one that action got. */
function ask(
	{ stableKey, state }: ModemMutationBlock,
	action: RecoveryAction,
): Promise<Reply> {
	const target = { stableKey, confirm: true } as const;
	if (action === "gone")
		return withinBound("decommissionMutation", () =>
			rpc.modems.decommissionMutation(target),
		);
	if (action === "keep" && state === "recommission-pending")
		return withinBound("rebaselineMutation", () =>
			rpc.modems.rebaselineMutation(target),
		);
	return withinBound("acknowledgeMutation", () =>
		rpc.modems.acknowledgeMutation({
			...target,
			mode: action === "keep" ? "force-rebaseline" : "verified-rollback",
		}),
	);
}

/** What an answer is about: the block pressed, or the state that answer put it in. */
function subjectOf(
	pressed: ModemMutationBlock,
	action: RecoveryAction,
	answer: ModemMutationAckOutput | undefined,
	outcome: RecoveryOutcome,
	now: ModemMutationBlock | undefined,
): ModemMutationBlock | undefined {
	if (outcome.kind === "applied") return undefined;
	switch (answer?.error) {
		case "device_absent":
			return now?.state === "device-absent-quarantine" ? now : pressed;
		case "state_mismatch":
			return action === "gone" && now?.state === "failed" ? now : pressed;
		case "read_failed":
			return now?.state === pressed.state ? pressed : now;
		case undefined:
			return pressed;
		default:
			return now;
	}
}

function outcomeOf(
	action: RecoveryAction,
	answer: ModemMutationAckOutput | undefined,
	now: ModemMutationBlock | undefined,
): RecoveryOutcome {
	if (answer?.success) {
		return {
			kind: "applied",
			messageKey:
				answer.state === "decommissioned"
					? "network.block.gone"
					: "network.block.settled",
		};
	}
	// A decision that could not be saved is not done, whatever the list shows.
	if (answer?.error !== "journal_write_failed" && isSettled(now)) {
		return { kind: "applied", messageKey: "network.block.elsewhere" };
	}
	if (answer === undefined) {
		return { kind: "unknown", messageKey: "network.block.unanswered" };
	}
	const refused = (messageKey: string): RecoveryOutcome => ({
		kind: "refused",
		messageKey,
	});
	switch (answer.error) {
		case "state_mismatch":
			return refused(
				{
					check: "network.block.mismatch",
					keep: "network.modem.refusal.deviceBusy",
					gone: "network.block.stillThere",
				}[action],
			);
		case "device_absent":
			return refused("network.block.notFound");
		case "read_failed":
			return refused(
				action === "check" || now?.state === "recommission-pending"
					? "network.block.unread"
					: "network.block.unidentified",
			);
		case "journal_write_failed":
			return refused("network.modem.refusal.writeFailed");
		case "no_entry":
		case "not_blocked":
		case undefined:
			return refused(
				action === "check" && now?.state === "device-absent-quarantine"
					? "network.block.notFound"
					: "network.block.changed",
			);
	}
}

export class MutationRecovery {
	#list = $state.raw<ModemMutationListOutput>();
	#outcomes = $state.raw<Readonly<Record<string, HeldOutcome>>>({});
	#pending = $state.raw<string>();
	#dispatched = 0;
	#applied = 0;

	readonly #blocks = $derived(this.#list?.blocks ?? []);
	readonly #replaying = $derived(this.#list?.replayComplete === false);

	get read(): boolean {
		return this.#list !== undefined;
	}

	/** Its startup replay may still add blocks to the list it gave. */
	get replaying(): boolean {
		return this.#replaying;
	}

	/** The block whose answer is being waited for; one action runs at a time. */
	get pending(): string | undefined {
		return this.#pending;
	}

	blockFor(stableKey: string): ModemMutationBlock | undefined {
		return this.#blocks.find((block) => block.stableKey === stableKey);
	}

	place(rows: readonly (readonly [string, Modem])[]): PlacedNotices {
		const byRow = new Map<string, RecoveryNotice>();
		const unlisted: RecoveryNotice[] = [];
		const keys = new Set([
			...this.#blocks.map((block) => block.stableKey),
			...Object.keys(this.#outcomes),
		]);
		for (const stableKey of keys) {
			const row = rows.find(([, modem]) => modem.stable_key === stableKey)?.[0];
			const held = this.blockFor(stableKey);
			const block =
				held === undefined ||
				recoveryView(held) === undefined ||
				(held.state === "decommissioned" && row === undefined)
					? undefined
					: held;
			const outcome = this.#outcomes[stableKey];
			if (block === undefined && outcome === undefined) continue;
			const notice: RecoveryNotice = { stableKey, block, outcome };
			if (row === undefined) unlisted.push(notice);
			else byRow.set(row, notice);
		}
		return { byRow, unlisted };
	}

	async refresh(): Promise<void> {
		this.#dispatched += 1;
		const read = this.#dispatched;
		const link = getLinkEpoch();
		const list = await loadWithinBound("listMutationBlocks", () =>
			rpc.modems.listMutationBlocks(),
		);
		// A read that failed or never came says nothing about the modems, so the last
		// answer stands; the restored session, or the next event, reads again.
		if (list.phase !== "loaded") return;
		if (read < this.#applied || link !== getLinkEpoch()) return;
		this.#applied = read;
		this.#list = list.value;
		this.#endAnswers();
	}

	async act(block: ModemMutationBlock, action: RecoveryAction): Promise<void> {
		if (this.#pending !== undefined) return;
		const { stableKey } = block;
		this.#pending = stableKey;
		const { [stableKey]: _previous, ...others } = this.#outcomes;
		this.#outcomes = others;
		const { answer, late } = await ask(block, action);
		// A success is the device's own statement; a list read before it is older.
		if (answer?.success && this.#list !== undefined) {
			this.#dispatched += 1;
			this.#applied = this.#dispatched;
			this.#list = {
				...this.#list,
				blocks: this.#list.blocks.filter(
					(held) => held.stableKey !== stableKey,
				),
			};
		}
		await this.refresh();
		const now = this.blockFor(stableKey);
		const outcome = outcomeOf(action, answer, now);
		const about = subjectOf(block, action, answer, outcome, now);
		this.#outcomes = { ...this.#outcomes, [stableKey]: { ...outcome, about } };
		this.#endAnswers();
		this.#pending = undefined;
		const reread = () => this.refresh();
		void late?.then(reread, reread);
	}

	#endAnswers(): void {
		const kept: Record<string, HeldOutcome> = {};
		for (const [stableKey, outcome] of Object.entries(this.#outcomes)) {
			const about = this.blockFor(stableKey);
			if (isUnchanged(outcome.about, about)) kept[stableKey] = outcome;
			else if (outcome.kind === "unknown" && isSettled(about))
				kept[stableKey] = {
					kind: "applied",
					messageKey: "network.block.elsewhere",
					about,
				};
		}
		this.#outcomes = kept;
	}
}
