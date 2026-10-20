/**
 * A reference world for the Updates dialog's action/outcome flow: one action
 * kind, one device, one link, one dialog. It drives the PRODUCTION machine
 * (`reduceActions`) and keeps the ground truth beside it: what the device
 * really did with each request, which evidence really reached the dialog, and
 * which details read is the latest. WHEN the dialog must read is the
 * CONTRACT's (`contractMove`), written here from the contract document and
 * never imported from the production binder: a binder that stops re-reading
 * on a restored session diverges from this world (round-3 review C).
 */
import type {
	UpdateDetails,
	UpdateOrchestratorPhase,
} from "@ceraui/rpc/schemas";

import type { ActionVerdict } from "../../lib/updates/update-action-failure";
import {
	type ActionEvent,
	type ActionMachine,
	INITIAL_ACTIONS,
	reduceActions,
} from "../../lib/updates/update-action-outcome";
import type { DeviceFrame } from "../../lib/updates/update-device-follow.svelte";
import { deviceDetails, OFFERED_VERSION } from "./update-device";

export type WorldAction = "check" | "install";

export interface Shown {
	readonly checkedAt: number;
	readonly staged: boolean;
}

export interface Device extends Shown {
	readonly phase: UpdateOrchestratorPhase;
}

export type WorldVerdict =
	| "pending"
	| "accepted"
	/** A `{ success: false }` reply. */
	| "refused"
	/** The startup envelope, or a request never sent. */
	| "refused-pre"
	| "uncertain-lost"
	| "uncertain-error";

export interface WorldCall {
	readonly id: number;
	readonly session: number;
	readonly order: number;
	readonly delivered: boolean;
	readonly started: boolean;
	/** `abandoned`: the client timed out, the device may still act on it. */
	readonly transport: "flight" | "abandoned" | "done";
	readonly verdict: WorldVerdict;
	readonly baseline: Shown | undefined;
	readonly afterRead: number;
	/** Ground truth: evidence that settles it has reached the dialog. */
	readonly evidence: boolean;
}

export interface WorldRead {
	readonly seq: number;
	readonly order: number;
	/** The open's `load()`: its capabilities land with it, if still current. */
	readonly load: boolean;
	readonly session: number;
	/** The capabilities read beside it was answered (the link was up). */
	readonly capsOk: boolean;
	/** `World.capsRead` when it started: a newer capabilities read supersedes it. */
	readonly caps: number;
}

export interface World {
	readonly action: WorldAction;
	readonly machine: ActionMachine;
	readonly device: Device;
	readonly link: boolean;
	readonly open: boolean;
	readonly session: number;
	readonly seen: DeviceFrame;
	readonly seq: number;
	readonly order: number;
	readonly reads: readonly WorldRead[];
	readonly shown: Shown | undefined;
	readonly detailsFailed: boolean;
	/**
	 * The latest capabilities read failed. A `load()` or a restored session
	 * re-reads them (FIX-16-FRONT3 R5); this world never replaces the image.
	 */
	readonly capsFailed: boolean;
	/** Capabilities reads started so far: only the latest one lands. */
	readonly capsRead: number;
	readonly calls: readonly WorldCall[];
	readonly sent: number;
}

const STAGED_IMAGE = { version: OFFERED_VERSION, stagedAt: 5_000 };

export function detailsOf(shown: Shown): UpdateDetails {
	return deviceDetails({
		checkedAt: shown.checkedAt,
		...(shown.staged ? { staged: STAGED_IMAGE, candidate: null } : {}),
	});
}

export function initialWorld(action: WorldAction): World {
	return {
		action,
		machine: INITIAL_ACTIONS,
		device: { phase: "idle", checkedAt: 1_000, staged: false },
		link: true,
		open: true,
		session: 0,
		seen: { open: true, phase: "idle", restored: 0 },
		seq: 1,
		order: 1,
		reads: [],
		shown: { checkedAt: 1_000, staged: false },
		detailsFailed: false,
		capsFailed: false,
		capsRead: 1,
		calls: [],
		sent: 0,
	};
}

export function apply(w: World, event: ActionEvent): World {
	return { ...w, machine: reduceActions(w.machine, event) };
}

export function patchCall(
	w: World,
	id: number,
	patch: Partial<WorldCall>,
): World {
	return {
		...w,
		calls: w.calls.map((call) =>
			call.id === id ? { ...call, ...patch } : call,
		),
	};
}

function markEvidence(w: World, settles: (call: WorldCall) => boolean): World {
	return {
		...w,
		calls: w.calls.map((call) =>
			call.session === w.session &&
			(call.verdict === "pending" || call.verdict.startsWith("uncertain")) &&
			settles(call)
				? { ...call, evidence: true }
				: call,
		),
	};
}

function changed(action: WorldAction, before: Shown, after: Shown): boolean {
	return action === "check"
		? after.checkedAt !== before.checkedAt
		: after.staged && !before.staged;
}

function settleLoad(w: World, read: WorldRead): World {
	return read.load && read.session === w.session && read.caps === w.capsRead
		? { ...w, capsFailed: !read.capsOk }
		: w;
}

export function failRead(w: World, read: WorldRead): World {
	const reads = w.reads.filter((entry) => entry.seq !== read.seq);
	const settled = settleLoad({ ...w, reads }, read);
	if (read.seq !== w.seq) return settled;
	return {
		...settled,
		detailsFailed: true,
		shown: read.load ? undefined : w.shown,
	};
}

export function landRead(w: World, read: WorldRead): World {
	const reads = w.reads.filter((entry) => entry.seq !== read.seq);
	if (read.seq !== w.seq) return settleLoad({ ...w, reads }, read);
	const shown = { checkedAt: w.device.checkedAt, staged: w.device.staged };
	const landed = markEvidence(
		settleLoad({ ...w, reads, shown, detailsFailed: false }, read),
		(call) =>
			call.afterRead < read.seq &&
			call.baseline !== undefined &&
			changed(w.action, call.baseline, shown),
	);
	return apply(landed, {
		type: "read",
		seq: read.seq,
		details: detailsOf(shown),
	});
}

export function startRead(w: World, load: boolean): World {
	const capsRead = load ? w.capsRead + 1 : w.capsRead;
	const read = {
		seq: w.seq + 1,
		order: w.order + 1,
		load,
		session: w.session,
		capsOk: w.link,
		caps: capsRead,
	};
	const started = { ...w, seq: read.seq, order: read.order, capsRead };
	if (!w.link) return failRead(started, read);
	return { ...started, reads: [...w.reads, read] };
}

/**
 * The contract (`an-update-action-outcome-is-decided-by-evidence.md`): an OPEN
 * dialog reads again when the pushed phase CHANGES, and when a session is
 * restored even though the phase did not change. A frame that does both
 * forwards the phase once and still re-reads the settings (early oracle F6).
 */
type ContractMove =
	| { readonly kind: "none" }
	| {
			readonly kind: "phase";
			readonly phase: UpdateOrchestratorPhase | undefined;
			readonly reread?: true;
	  }
	| { readonly kind: "reread" };

export function contractMove(
	seen: DeviceFrame,
	next: DeviceFrame,
): ContractMove {
	if (!next.open) return { kind: "none" };
	const restored = next.restored !== seen.restored;
	if (next.phase !== seen.phase)
		return restored
			? { kind: "phase", phase: next.phase, reread: true }
			: { kind: "phase", phase: next.phase };
	return restored ? { kind: "reread" } : { kind: "none" };
}

export function frame(w: World, patch: Partial<DeviceFrame>): World {
	const next = { ...w.seen, ...patch };
	const move = contractMove(w.seen, next);
	const seen = { ...w, seen: next };
	// A restored session re-reads the capabilities; the scripted device answers
	// at once with the unchanged image's declaration.
	const restored =
		move.kind === "reread" || (move.kind === "phase" && move.reread === true)
			? { ...seen, capsFailed: false, capsRead: w.capsRead + 1 }
			: seen;
	switch (move.kind) {
		case "none":
			return seen;
		case "reread":
			return startRead(restored, false);
		case "phase": {
			const { phase } = move;
			if (phase === undefined) return startRead(restored, false);
			const started =
				phase === (w.action === "check" ? "checking" : "os-staging");
			const marked = markEvidence(restored, () => started);
			return startRead(apply(marked, { type: "phase", phase }), false);
		}
		default: {
			const unreachable: never = move;
			return unreachable;
		}
	}
}

export function push(w: World, phase: UpdateOrchestratorPhase): World {
	return w.link ? frame(w, { phase }) : w;
}

export function conclude(
	w: World,
	call: WorldCall,
	verdict: ActionVerdict,
	transport: WorldCall["transport"],
): World {
	const kind: WorldVerdict =
		verdict.kind === "uncertain"
			? `uncertain-${verdict.cause}`
			: verdict.kind === "refused" && verdict.preEffect
				? "refused-pre"
				: verdict.kind;
	const concluded = apply(patchCall(w, call.id, { transport, verdict: kind }), {
		type: "conclude",
		call: call.id,
		verdict,
	});
	return call.session === concluded.session
		? startRead(concluded, false)
		: concluded;
}

export const LOST: ActionVerdict = { kind: "uncertain", cause: "lost" };

export function inFlight(w: World): WorldCall | undefined {
	return w.calls.find((call) => call.transport === "flight");
}

/**
 * A request the device can still start. An image already staged cannot be
 * staged again: the producer refuses a second install before any effect.
 */
export function startable(w: World): WorldCall | undefined {
	if (w.action === "install" && w.device.staged) return undefined;
	return w.calls.find(
		(call) =>
			call.delivered &&
			!call.started &&
			call.verdict !== "refused" &&
			call.verdict !== "refused-pre",
	);
}
