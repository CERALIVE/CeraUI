/**
 * The Updates dialog's device reads and writes (Todo 41), owned by ONE dialog
 * mount at a time.
 *
 * Reads. Capabilities, settings and details are pulled together on the open
 * edge, and details again on every pushed phase change. ONE latest-read counter
 * owns `details`, whichever path started the read, and settings have their own
 * that a save echo also advances: an answer lands only if nothing newer was
 * started after it, so a slow opening snapshot can never overwrite a newer read
 * or an echoed save (C-M2). Capabilities have their own counter too. A restored
 * session re-reads all three: an OS replacement changes the image behind a
 * dropped link (early oracle R5).
 *
 * Sessions. `reset()` (the dialog closing) starts a new session. Every write
 * still in flight (a read, a save echo, an action's result and the read it
 * would start) belongs to the session it began in and lands nowhere once that
 * session has ended.
 *
 * Writes are PESSIMISTIC: the rendered value moves only to what the device
 * echoed back, never to what was clicked. Settings writes and their verdicts
 * live in `update-settings-owner.svelte.ts`; the operator actions and their
 * outcomes in `update-actions.svelte.ts`, which this surface feeds every pushed
 * phase, every legacy state kind and every details read that lands. Every
 * landed read also feeds the OS-check witness (`os-offer-witness.ts`), the only
 * evidence for "no newer system image".
 */
import type {
	UpdateCapabilities,
	UpdateDetails,
	UpdateOrchestratorPhase,
	UpdateSettings,
	UpdateState,
} from "@ceraui/rpc/schemas";

import { rpc } from "$lib/rpc/client";
import { getLinkEpoch } from "$lib/rpc/session-epoch.svelte";
import {
	NO_WITNESS,
	witnessedNothingNewer,
	witnessPhase,
	witnessRead,
} from "./os-offer-witness";
import type { ActionBand, ActionOutcome } from "./update-action-outcome";
import {
	type ActionRefusal,
	createUpdateActions,
	type UpdateActionKind,
} from "./update-actions.svelte";
import { osCheckFoundNothing } from "./update-dialog-view";
import {
	createSettingsOwner,
	type SaveOutcome,
} from "./update-settings-owner.svelte";

export {
	type ActionRefusal,
	UPDATE_CELLULAR_OP,
	UPDATE_CHECK_NOW_OP,
	UPDATE_INSTALL_NOW_OP,
	type UpdateActionKind,
} from "./update-actions.svelte";
export {
	type SaveOutcome,
	UPDATE_SETTINGS_OP,
} from "./update-settings-owner.svelte";

export interface UpdateSurface {
	readonly capabilities: UpdateCapabilities | undefined;
	readonly packagesReady: boolean;
	readonly settings: UpdateSettings | undefined;
	readonly details: UpdateDetails | undefined;
	/** `true` once a load attempt finished, whatever it returned. */
	readonly loaded: boolean;
	readonly settingsFailed: boolean;
	readonly detailsFailed: boolean;
	/** The last settings write was not sent, or the device did not confirm it. */
	readonly saveFailed: boolean;
	readonly saveOutcome: SaveOutcome | undefined;
	/** Every orchestrator action outcome on screen, oldest dispatch first. */
	readonly bands: readonly ActionBand[];
	readonly refusal: ActionRefusal | undefined;
	/** An action nobody can confirm yet: no answer proved it, no device report settled it. */
	readonly unconfirmed: UpdateActionKind | undefined;
	/** The legacy Packages Update's outcome in this session. */
	readonly packagesOutcome: ActionOutcome | undefined;
	readonly saving: boolean;
	pending(action: UpdateActionKind): boolean;
	/** "No newer system image": a check this dialog saw complete found nothing. */
	osNothingNewer(phase: UpdateOrchestratorPhase | undefined): boolean;
	load(): Promise<void>;
	reloadDetails(): Promise<void>;
	/** A restored session: the device (even its image) may have changed anything, read it all. */
	reread(): Promise<void>;
	/** A restored session whose phase change already re-reads the details: settings and capabilities. */
	rereadOnRestore(): Promise<void>;
	/** The pushed phase moved: keep it as evidence, then re-read the details. */
	observePhase(phase: UpdateOrchestratorPhase | undefined): Promise<void>;
	observeLegacy(kind: UpdateState["kind"] | undefined): void;
	save(patch: Partial<UpdateSettings>): Promise<boolean>;
	checkNow(): Promise<void>;
	installNow(): Promise<void>;
	installPackages(): Promise<void>;
	approveCellular(id: string): Promise<void>;
	reset(): void;
}

// Turns a synchronous throw (an RPC a backend does not expose) into one
// rejected read, so it cannot abort the reads batched beside it.
async function settle<T>(call: () => Promise<T>): Promise<T> {
	return call();
}

const orchestratorBand = (band: ActionBand): boolean =>
	band.action !== "packages";

export function createUpdateSurface(): UpdateSurface {
	let capabilities = $state.raw<UpdateCapabilities | undefined>();
	let details = $state.raw<UpdateDetails | undefined>();
	let witness = $state.raw(NO_WITNESS);
	let loaded = $state(false);
	let capabilitiesFailed = $state(false);
	let detailsReadFailed = $state(false);
	let loadSeq = 0;
	let detailsSeq = 0;
	let capsSeq = 0;
	let capsLink = getLinkEpoch();
	const owner = createSettingsOwner();

	const actions = createUpdateActions({
		dispatchContext: () => ({
			afterRead: detailsSeq,
			clocks: details?.checks,
			staged: details === undefined ? undefined : details.os.staged,
		}),
		reloadDetails,
	});

	// `link` is the link the read STARTED on: an answer can only testify about
	// the process it was asked of, whenever it lands (early oracle F2).
	function landDetails(gen: number, next: UpdateDetails, link: number): void {
		details = next;
		detailsReadFailed = false;
		witness = witnessRead(witness, link, next);
		actions.observeRead(gen, next);
	}

	// The image's declaration. A failed read is UNKNOWN (no legacy claim, the
	// failure band), never the previous image's answer kept (early oracle R5).
	function landCapabilities(
		gen: number,
		caps: PromiseSettledResult<UpdateCapabilities>,
		link: number,
	): void {
		if (gen !== capsSeq || link !== getLinkEpoch()) return;
		capabilities = caps.status === "fulfilled" ? caps.value : undefined;
		capsLink = link;
		capabilitiesFailed = caps.status === "rejected";
	}

	async function reloadCapabilities(): Promise<void> {
		const gen = ++capsSeq;
		capabilities = undefined;
		const link = getLinkEpoch();
		const [caps] = await Promise.allSettled([
			settle(() => rpc.system.getUpdateCapabilities()),
		]);
		landCapabilities(gen, caps, link);
	}

	async function load(): Promise<void> {
		const gen = ++loadSeq;
		const capsGen = ++capsSeq;
		capabilities = undefined;
		const settingsGen = owner.beginRead();
		const detailsGen = ++detailsSeq;
		const link = getLinkEpoch();
		const [caps, applied, read] = await Promise.allSettled([
			settle(() => rpc.system.getUpdateCapabilities()),
			settle(() => rpc.system.getUpdateSettings()),
			settle(() => rpc.system.getUpdateDetails()),
		]);
		landCapabilities(capsGen, caps, link);
		if (gen === loadSeq) loaded = true;
		if (applied.status === "fulfilled")
			owner.landRead(settingsGen, applied.value);
		else owner.failRead(settingsGen);
		if (detailsGen === detailsSeq) {
			if (read.status === "fulfilled")
				landDetails(detailsGen, read.value, link);
			else {
				details = undefined;
				detailsReadFailed = true;
			}
		}
	}

	async function reloadDetails(): Promise<void> {
		const gen = ++detailsSeq;
		const link = getLinkEpoch();
		try {
			const next = await settle(() => rpc.system.getUpdateDetails());
			if (gen === detailsSeq) landDetails(gen, next, link);
		} catch {
			if (gen !== detailsSeq) return;
			detailsReadFailed = true;
		}
	}

	return {
		get capabilities() {
			return capabilities;
		},
		get packagesReady() {
			return capabilities !== undefined && capsLink === getLinkEpoch();
		},
		get settings() {
			return owner.settings;
		},
		get details() {
			return details;
		},
		get loaded() {
			return loaded;
		},
		get settingsFailed() {
			return owner.failed;
		},
		get detailsFailed() {
			return capabilitiesFailed || detailsReadFailed;
		},
		get saveFailed() {
			return owner.outcome !== undefined;
		},
		get saveOutcome() {
			return owner.outcome;
		},
		get bands() {
			return actions.bands.filter(orchestratorBand);
		},
		get refusal() {
			const refusal = actions.refusal;
			return refusal?.action === "packages" ? undefined : refusal;
		},
		get unconfirmed() {
			const action = actions.unconfirmed;
			return action === "packages" ? undefined : action;
		},
		get packagesOutcome() {
			return actions.outcomeOf("packages");
		},
		get saving() {
			return owner.saving;
		},
		pending: actions.pending,
		osNothingNewer: (phase) =>
			witnessedNothingNewer(witness, getLinkEpoch(), details) &&
			osCheckFoundNothing(details, phase),
		load,
		reloadDetails,
		reread: async () => {
			await Promise.all([
				reloadDetails(),
				owner.reread(),
				reloadCapabilities(),
			]);
		},
		rereadOnRestore: async () => {
			await Promise.all([owner.reread(), reloadCapabilities()]);
		},
		observePhase(phase) {
			if (phase !== undefined) {
				actions.observePhase(phase);
				witness = witnessPhase(witness, phase);
			}
			return reloadDetails();
		},
		observeLegacy: actions.observeLegacy,
		save: owner.save,
		checkNow: () => actions.run("check", [() => rpc.system.checkUpdatesNow()]),
		installNow: () =>
			actions.run("install", [() => rpc.system.installUpdatesNow()]),
		installPackages: async () => {
			if (capabilities === undefined || capsLink !== getLinkEpoch()) return;
			if (capabilities.mode === "legacy")
				return actions.run("packages", [() => rpc.system.startUpdate()]);
			return actions.run("install", [
				() => rpc.system.installUpdatesNow({ scope: "packages" }),
			]);
		},
		// The approval is for exactly ONE candidate and is spent by the install
		// that follows it; granting it without starting the download would leave
		// "Download now" meaning "download some time later". Both requests are
		// one action: it stays busy until the second one settles.
		approveCellular: (id) =>
			actions.run("cellular", [
				() => rpc.system.allowCellularOnce({ id }),
				() => rpc.system.installUpdatesNow(),
			]),
		reset() {
			loadSeq += 1;
			detailsSeq += 1;
			capsSeq += 1;
			capabilities = undefined;
			actions.reset();
			owner.reset();
		},
	};
}
