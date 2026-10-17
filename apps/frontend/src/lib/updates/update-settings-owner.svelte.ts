/**
 * The Updates dialog's settings: what the device last reported, and the ONE
 * write that may be in flight (round-3 review C, C3-3).
 *
 * Ownership. A save owns the settings controls from the click until its whole
 * request chain SETTLES. It never leans on the shared operation valve, whose
 * default lapses before the client's own 30 s call timeout: a second write
 * admitted then would carry the first one's stale snapshot and undo it. A click
 * while a write is in flight is dropped before anything is sent.
 *
 * Basis. The wire takes the whole settings object (no field patch, no
 * compare-and-swap) and settings are not pushed, so every write is built from
 * a settings read STARTED after the click: a remote change, or this dialog's
 * own lost write that the device did apply, is never overwritten with what the
 * dialog happened to show.
 *
 * Verdict. Only a request the client never sent (or whose basis read failed,
 * so the write was never built) is "not sent". Any other failure is "not
 * confirmed": the device may have saved it. That band names the settings on
 * screen as the last ones the device reported, re-reads them at once, and
 * clears when a read shows the requested values, a new save starts, or the
 * dialog closes.
 */
import type { UpdateSettings } from "@ceraui/rpc/schemas";

import { osCommand } from "$lib/rpc/async-operation.svelte";
import { rpc } from "$lib/rpc/client";
import { NotSentError } from "$lib/rpc/rpc-error";
import { RPC_CALL_TIMEOUT_MS } from "$lib/rpc/rpc-timeouts";
import { withSettings } from "./update-view";

export const UPDATE_SETTINGS_OP = "update-settings";

export type SaveOutcome =
	| { readonly kind: "not-sent" }
	| {
			readonly kind: "unconfirmed";
			readonly requested: Partial<UpdateSettings>;
	  };

export interface SettingsOwner {
	readonly settings: UpdateSettings | undefined;
	/** The open's read failed; nothing was shown. */
	readonly failed: boolean;
	readonly saving: boolean;
	readonly outcome: SaveOutcome | undefined;
	/** Starts a read; only the newest read or echo may land. */
	beginRead(): number;
	landRead(gen: number, value: UpdateSettings): void;
	failRead(gen: number): void;
	/** A fresh read that keeps what is shown when it fails. */
	reread(): Promise<void>;
	save(patch: Partial<UpdateSettings>): Promise<boolean>;
	reset(): void;
}

function carries(
	value: UpdateSettings,
	requested: Partial<UpdateSettings>,
): boolean {
	const merged = withSettings(value, requested);
	return JSON.stringify(merged) === JSON.stringify(value);
}

/** Both requests of a save, each bounded by the client's own timeout. */
const WRITE_TTL_MS = 2 * RPC_CALL_TIMEOUT_MS + 5_000;

export function createSettingsOwner(): SettingsOwner {
	let settings = $state.raw<UpdateSettings | undefined>();
	let failed = $state(false);
	let saving = $state(false);
	let outcome = $state.raw<SaveOutcome | undefined>();
	let seq = 0;
	let session = 0;

	function beginRead(): number {
		seq += 1;
		return seq;
	}

	function landRead(gen: number, value: UpdateSettings): void {
		if (gen !== seq) return;
		settings = value;
		failed = false;
		if (outcome?.kind === "unconfirmed" && carries(value, outcome.requested))
			outcome = undefined;
	}

	async function reread(): Promise<void> {
		const gen = beginRead();
		try {
			landRead(gen, await rpc.system.getUpdateSettings());
		} catch {
			// What is shown stays the last thing the device reported.
		}
	}

	async function write(
		basis: UpdateSettings,
		patch: Partial<UpdateSettings>,
	): Promise<UpdateSettings | SaveOutcome> {
		let fault: unknown;
		let sent = false;
		const echo = await osCommand({
			key: UPDATE_SETTINGS_OP,
			pendingTtlMs: WRITE_TTL_MS,
			rpc: async () => {
				sent = true;
				try {
					return await rpc.system.setUpdateSettings(withSettings(basis, patch));
				} catch (error) {
					fault = error;
					throw error;
				}
			},
			confirmOnResolve: true,
			silent: true,
		});
		if (echo !== undefined) return echo;
		return !sent || fault instanceof NotSentError
			? { kind: "not-sent" }
			: { kind: "unconfirmed", requested: patch };
	}

	async function save(patch: Partial<UpdateSettings>): Promise<boolean> {
		if (saving || settings === undefined) return false;
		saving = true;
		outcome = undefined;
		const opened = session;
		try {
			let basis: UpdateSettings;
			const gen = beginRead();
			try {
				basis = await rpc.system.getUpdateSettings();
				landRead(gen, basis);
			} catch {
				if (opened === session) outcome = { kind: "not-sent" };
				return false;
			}
			if (opened !== session) return false;
			const result = await write(basis, patch);
			if (opened !== session) return false;
			if ("kind" in result) {
				outcome = result;
				if (result.kind === "unconfirmed") void reread();
				return false;
			}
			seq += 1;
			settings = result;
			return true;
		} finally {
			saving = false;
		}
	}

	return {
		get settings() {
			return settings;
		},
		get failed() {
			return failed;
		},
		get saving() {
			return saving;
		},
		get outcome() {
			return outcome;
		},
		beginRead,
		landRead,
		failRead(gen) {
			if (gen !== seq) return;
			settings = undefined;
			failed = true;
		},
		reread,
		save,
		reset() {
			session += 1;
			seq += 1;
			outcome = undefined;
		},
	};
}
