/**
 * The Updates dialog's device reads and writes (Todo 41), owned by ONE dialog
 * mount at a time.
 *
 * Reads. Capabilities, settings and details are pulled together on the open
 * edge, and details again on every pushed phase change. ONE latest-read counter
 * owns `details`, whichever path started the read, and settings have their own
 * that a save echo also advances: an answer lands only if nothing newer was
 * started after it, so a slow opening snapshot can never overwrite a newer read
 * or an echoed save (C-M2).
 *
 * Sessions. `reset()` (the dialog closing) starts a new session. Every write
 * still in flight (a read, a save echo, an action's result and the read it
 * would start) belongs to the session it began in and lands nowhere once that
 * session has ended.
 *
 * Writes go through `osCommand` and are PESSIMISTIC: the rendered value moves
 * only to what the device echoed back, never to what was clicked. The three
 * operator actions and their outcomes live in `update-actions.svelte.ts`.
 */
import type {
	UpdateCapabilities,
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateSettings,
} from "@ceraui/rpc/schemas";

import { getOperationPhase, osCommand } from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import {
	type ActionRefusal,
	createUpdateActions,
	type UpdateActionKind,
} from "./update-actions.svelte";
import { withSettings } from "./update-view";

export {
	type ActionRefusal,
	UPDATE_CELLULAR_OP,
	UPDATE_CHECK_NOW_OP,
	UPDATE_INSTALL_NOW_OP,
	type UpdateActionKind,
} from "./update-actions.svelte";

export const UPDATE_SETTINGS_OP = "update-settings";

export interface UpdateSurface {
	readonly capabilities: UpdateCapabilities | undefined;
	readonly settings: UpdateSettings | undefined;
	readonly details: UpdateDetails | undefined;
	/** `true` once a load attempt finished, whatever it returned. */
	readonly loaded: boolean;
	readonly settingsFailed: boolean;
	readonly detailsFailed: boolean;
	/** The last settings write the device did not confirm. */
	readonly saveFailed: boolean;
	readonly refusal: ActionRefusal | undefined;
	/** An action whose reply never arrived and that the device has not settled yet. */
	readonly unconfirmed: UpdateActionKind | undefined;
	readonly saving: boolean;
	pending(action: UpdateActionKind): boolean;
	load(): Promise<void>;
	reloadDetails(): Promise<void>;
	/** The pushed phase moved: keep it as evidence, then re-read the details. */
	observePhase(phase: UpdateOrchestratorPhase | undefined): Promise<void>;
	save(patch: Partial<UpdateSettings>): Promise<boolean>;
	checkNow(): Promise<void>;
	installNow(): Promise<void>;
	approveCellular(id: string): Promise<void>;
	reset(): void;
}

// Turns a synchronous throw (an RPC a backend does not expose) into one
// rejected read, so it cannot abort the reads batched beside it.
async function settle<T>(call: () => Promise<T>): Promise<T> {
	return call();
}

export function createUpdateSurface(): UpdateSurface {
	let capabilities = $state.raw<UpdateCapabilities | undefined>();
	let settings = $state.raw<UpdateSettings | undefined>();
	let details = $state.raw<UpdateDetails | undefined>();
	let loaded = $state(false);
	let settingsFailed = $state(false);
	let capabilitiesFailed = $state(false);
	let detailsReadFailed = $state(false);
	let saveFailed = $state(false);
	let session = 0;
	let loadSeq = 0;
	let settingsSeq = 0;
	let detailsSeq = 0;
	let detailsRead = 0;

	const actions = createUpdateActions({
		evidence: () => ({ details, detailsRead }),
		latestRead: () => detailsSeq,
		reloadDetails,
	});

	async function load(): Promise<void> {
		const gen = ++loadSeq;
		const settingsGen = ++settingsSeq;
		const detailsGen = ++detailsSeq;
		const [caps, applied, read] = await Promise.allSettled([
			settle(() => rpc.system.getUpdateCapabilities()),
			settle(() => rpc.system.getUpdateSettings()),
			settle(() => rpc.system.getUpdateDetails()),
		]);
		if (gen === loadSeq) {
			capabilities = caps.status === "fulfilled" ? caps.value : undefined;
			capabilitiesFailed = caps.status === "rejected";
			loaded = true;
		}
		if (settingsGen === settingsSeq) {
			settings = applied.status === "fulfilled" ? applied.value : undefined;
			settingsFailed = applied.status === "rejected";
		}
		if (detailsGen === detailsSeq) {
			details = read.status === "fulfilled" ? read.value : undefined;
			detailsRead = detailsGen;
			detailsReadFailed = read.status === "rejected";
			actions.settle();
		}
	}

	async function reloadDetails(): Promise<void> {
		const gen = ++detailsSeq;
		try {
			const next = await settle(() => rpc.system.getUpdateDetails());
			if (gen !== detailsSeq) return;
			details = next;
			detailsRead = gen;
			detailsReadFailed = false;
		} catch {
			if (gen !== detailsSeq) return;
			detailsReadFailed = true;
		}
		actions.settle();
	}

	async function save(patch: Partial<UpdateSettings>): Promise<boolean> {
		const current = settings;
		// A write already in flight owns the control; this click is not a
		// failure, it simply did not happen.
		if (
			current === undefined ||
			getOperationPhase(UPDATE_SETTINGS_OP) === "pending"
		) {
			return false;
		}
		const opened = session;
		saveFailed = false;
		const result = await osCommand({
			key: UPDATE_SETTINGS_OP,
			rpc: () => rpc.system.setUpdateSettings(withSettings(current, patch)),
			confirmOnResolve: true,
			silent: true,
		});
		if (opened !== session) return false;
		if (result === undefined) {
			saveFailed = true;
			return false;
		}
		// The echo is newer than any settings read still in flight.
		settingsSeq += 1;
		settings = result;
		return true;
	}

	return {
		get capabilities() {
			return capabilities;
		},
		get settings() {
			return settings;
		},
		get details() {
			return details;
		},
		get loaded() {
			return loaded;
		},
		get settingsFailed() {
			return settingsFailed;
		},
		get detailsFailed() {
			return capabilitiesFailed || detailsReadFailed;
		},
		get saveFailed() {
			return saveFailed;
		},
		get refusal() {
			return actions.refusal;
		},
		get unconfirmed() {
			return actions.unconfirmed;
		},
		get saving() {
			return getOperationPhase(UPDATE_SETTINGS_OP) === "pending";
		},
		pending: actions.pending,
		load,
		reloadDetails,
		observePhase(phase) {
			if (phase !== undefined) actions.observe(phase);
			return reloadDetails();
		},
		save,
		checkNow: () => actions.run("check", () => rpc.system.checkUpdatesNow()),
		installNow: () =>
			actions.run("install", () => rpc.system.installUpdatesNow()),
		// The approval is for exactly ONE candidate and is spent by the install
		// that follows it; granting it without starting the download would leave
		// "Download now" meaning "download some time later".
		approveCellular: (id) =>
			actions.run("cellular", async () => {
				const granted = await rpc.system.allowCellularOnce({ id });
				if (!granted.success) return granted;
				return rpc.system.installUpdatesNow();
			}),
		reset() {
			session += 1;
			loadSeq += 1;
			settingsSeq += 1;
			detailsSeq += 1;
			actions.reset();
			saveFailed = false;
		},
	};
}
