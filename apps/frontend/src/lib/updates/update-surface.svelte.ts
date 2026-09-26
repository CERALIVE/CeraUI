/**
 * The Updates dialog's device reads and writes (Todo 41), owned by ONE dialog
 * mount at a time.
 *
 * Three reads — capabilities, settings, details — are pulled together on the
 * open edge and generation-fenced, so a reply from a closed or superseded open
 * can never overwrite the current one. Every write goes through `osCommand`
 * and is PESSIMISTIC: the rendered value moves only to what the device echoed
 * back (`setUpdateSettings` answers with the complete applied settings), never
 * to what was clicked.
 */
import type {
	UpdateCapabilities,
	UpdateDetails,
	UpdateSettings,
} from "@ceraui/rpc/schemas";

import { getOperationPhase, osCommand } from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";

import { withSettings } from "./update-view";

export const UPDATE_SETTINGS_OP = "update-settings";
export const UPDATE_CHECK_NOW_OP = "update-check-now";
export const UPDATE_INSTALL_NOW_OP = "update-install-now";
export const UPDATE_CELLULAR_OP = "update-cellular-approve";

type ActionKind = "check" | "install" | "cellular";

export interface ActionRefusal {
	readonly action: ActionKind;
	readonly reason: string | undefined;
}

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
	readonly saving: boolean;
	pending(action: ActionKind): boolean;
	load(): Promise<void>;
	reloadDetails(): Promise<void>;
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

const ACTION_OPS: Readonly<Record<ActionKind, string>> = {
	check: UPDATE_CHECK_NOW_OP,
	install: UPDATE_INSTALL_NOW_OP,
	cellular: UPDATE_CELLULAR_OP,
};

export function createUpdateSurface(): UpdateSurface {
	let capabilities = $state.raw<UpdateCapabilities | undefined>();
	let settings = $state.raw<UpdateSettings | undefined>();
	let details = $state.raw<UpdateDetails | undefined>();
	let loaded = $state(false);
	let settingsFailed = $state(false);
	let detailsFailed = $state(false);
	let saveFailed = $state(false);
	let refusal = $state.raw<ActionRefusal | undefined>();
	let generation = 0;
	let detailsGeneration = 0;

	async function load(): Promise<void> {
		const gen = ++generation;
		const [caps, applied, read] = await Promise.allSettled([
			settle(() => rpc.system.getUpdateCapabilities()),
			settle(() => rpc.system.getUpdateSettings()),
			settle(() => rpc.system.getUpdateDetails()),
		]);
		if (gen !== generation) return;
		capabilities = caps.status === "fulfilled" ? caps.value : undefined;
		settings = applied.status === "fulfilled" ? applied.value : undefined;
		settingsFailed = applied.status === "rejected";
		details = read.status === "fulfilled" ? read.value : undefined;
		detailsFailed = read.status === "rejected" || caps.status === "rejected";
		loaded = true;
	}

	async function reloadDetails(): Promise<void> {
		const gen = ++detailsGeneration;
		try {
			const next = await settle(() => rpc.system.getUpdateDetails());
			if (gen !== detailsGeneration) return;
			details = next;
			detailsFailed = false;
		} catch {
			if (gen !== detailsGeneration) return;
			detailsFailed = true;
		}
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
		saveFailed = false;
		const result = await osCommand({
			key: UPDATE_SETTINGS_OP,
			rpc: () => rpc.system.setUpdateSettings(withSettings(current, patch)),
			confirmOnResolve: true,
			silent: true,
		});
		if (result === undefined) {
			saveFailed = true;
			return false;
		}
		settings = result;
		return true;
	}

	async function runAction(
		action: ActionKind,
		call: () => Promise<{ success: boolean; error?: string }>,
	): Promise<void> {
		refusal = undefined;
		const result = await osCommand({
			key: ACTION_OPS[action],
			rpc: call,
			confirmOnResolve: true,
			silent: true,
		});
		if (!result?.success) refusal = { action, reason: result?.error };
		await reloadDetails();
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
			return detailsFailed;
		},
		get saveFailed() {
			return saveFailed;
		},
		get refusal() {
			return refusal;
		},
		get saving() {
			return getOperationPhase(UPDATE_SETTINGS_OP) === "pending";
		},
		pending: (action) => getOperationPhase(ACTION_OPS[action]) === "pending",
		load,
		reloadDetails,
		save,
		checkNow: () => runAction("check", () => rpc.system.checkUpdatesNow()),
		installNow: () =>
			runAction("install", () => rpc.system.installUpdatesNow()),
		// The approval is for exactly ONE candidate and is spent by the install
		// that follows it; granting it without starting the download would leave
		// "Download now" meaning "download some time later".
		approveCellular: (id) =>
			runAction("cellular", async () => {
				const granted = await rpc.system.allowCellularOnce({ id });
				if (!granted.success) return granted;
				return rpc.system.installUpdatesNow();
			}),
		reset() {
			generation += 1;
			detailsGeneration += 1;
			refusal = undefined;
			saveFailed = false;
		},
	};
}
