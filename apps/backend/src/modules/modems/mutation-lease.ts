/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The ONE helper every mutating modem entrypoint routes through.
 *
 * It exists so that "does this path take the interlock" is answerable by reading
 * the entrypoint rather than by auditing what it calls. Two shapes, and the
 * difference is exactly whether the mutation can cost connectivity:
 *
 *   withModemMutation          — lease only. For a mutation that cannot leave the
 *                                device in a state a rollback would have to
 *                                restore (a SIM PIN submit, a network scan).
 *   withJournaledModemMutation — lease PLUS a durable armed journal entry written
 *                                BEFORE the mutation runs and cancelled only after
 *                                it is confirmed. For anything that can cost the
 *                                bond link: APN/roaming/band/5G/USB-mode.
 *
 * IDENTITY IS FAIL-CLOSED. The identity contract permits an omitted `stable_key`,
 * and a mutation target without a resolvable physical key cannot be journaled,
 * cannot be rolled back, and cannot be re-found after a re-enumeration — so it is
 * refused with the typed `identity_unresolved` before anything is written and
 * before anything is mutated. It is deliberately NOT a throw: this runs at an RPC
 * boundary where a throw becomes an opaque failure the operator cannot act on.
 */

import { randomUUID } from "node:crypto";

import type {
	ModemMutationEntry,
	ModemMutationKind,
	ModemMutationRefusal,
} from "@ceraui/rpc/schemas";
import { MODEM_MUTATION_JOURNAL_VERSION } from "@ceraui/rpc/schemas";

import { logger } from "../../helpers/logger.ts";
import {
	type ModemMutationLease,
	tryAcquireModemMutation,
} from "../streaming/lifecycle-admission.ts";
import { refreshMutationBlocks } from "./mutation-blocks.ts";
import {
	commitMutationEntry,
	journalNow,
	nextEntry,
	removeMutationEntry,
} from "./mutation-journal.ts";

export type MutationOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly refusal: ModemMutationRefusal };

export type JournaledMutation = {
	readonly entry: ModemMutationEntry;
	/** Journal the switch to `executing` before the disruptive call is made. */
	markExecuting(): Promise<void>;
	/** Journal `failed`; the device stays fail-closed until acknowledged. */
	markFailed(detail: string): Promise<void>;
};

function refuse<T>(refusal: ModemMutationRefusal): MutationOutcome<T> {
	return { ok: false, refusal };
}

/**
 * Acquire the lease for a transaction whose confirmation is DEFERRED past the
 * caller's return — the remote `modem.reconfig` watchdog is the live example.
 * The caller owns `release()` and must call it once the transaction has confirmed,
 * auto-reverted, or reached an acknowledged terminal failure.
 */
export function beginModemMutation(stableKey: string | undefined):
	| { readonly ok: true; readonly lease: ModemMutationLease }
	| {
			readonly ok: false;
			readonly refusal: ModemMutationRefusal;
	  } {
	if (stableKey === undefined || stableKey === "") {
		return { ok: false, refusal: "identity_unresolved" };
	}
	const admission = tryAcquireModemMutation(stableKey);
	return admission.admitted
		? { ok: true, lease: admission.lease }
		: { ok: false, refusal: admission.refusal };
}

export async function withModemMutation<T>(
	stableKey: string | undefined,
	run: () => Promise<T>,
): Promise<MutationOutcome<T>> {
	const acquired = beginModemMutation(stableKey);
	if (!acquired.ok) return refuse(acquired.refusal);
	try {
		return { ok: true, value: await run() };
	} finally {
		acquired.lease.release();
	}
}

/**
 * Run a connectivity-losing mutation with a durable armed journal entry.
 *
 * The armed entry is committed through the full durability sequence BEFORE `run`
 * is called, so a crash at any instant leaves a record startup replay can act on.
 * `run` reporting success cancels the entry (a durable delete); `run` throwing, or
 * reporting failure, journals `failed` and leaves the device blocked until an
 * operator acknowledges — never a silent fail-open.
 *
 * A journal write that does not commit ABORTS the mutation, because the whole
 * guarantee is that no connectivity-losing call is made without a recoverable
 * record of what it was about to change.
 */
export async function withJournaledModemMutation<T>(
	stableKey: string | undefined,
	kind: ModemMutationKind,
	preState: Readonly<Record<string, unknown>>,
	run: (mutation: JournaledMutation) => Promise<{
		readonly confirmed: boolean;
		readonly value: T;
		readonly detail?: string;
	}>,
): Promise<MutationOutcome<T>> {
	const acquired = beginModemMutation(stableKey);
	if (!acquired.ok) return refuse(acquired.refusal);
	const key = acquired.lease.stableKey;

	const at = journalNow();
	let entry: ModemMutationEntry = {
		version: MODEM_MUTATION_JOURNAL_VERSION,
		stableKey: key,
		kind,
		state: "armed",
		attemptId: randomUUID(),
		startedAt: at,
		updatedAt: at,
		preState: { ...preState },
		history: [{ state: "armed", at }],
	};

	try {
		await commitMutationEntry(entry);
	} catch (err) {
		acquired.lease.release();
		logger.error("refusing a modem mutation: its journal did not commit", {
			module: "modems",
			stableKey: key,
			kind,
			err,
		});
		return refuse("mutation_blocked");
	}

	const advance = async (
		state: ModemMutationEntry["state"],
		detail?: string,
	): Promise<void> => {
		entry = nextEntry(entry, state, journalNow(), detail);
		await commitMutationEntry(entry);
	};

	try {
		const result = await run({
			entry,
			markExecuting: () => advance("executing"),
			markFailed: (detail) => advance("failed", detail),
		});
		if (result.confirmed) {
			await removeMutationEntry(key);
			return { ok: true, value: result.value };
		}
		await advance("failed", result.detail ?? "mutation was not confirmed");
		return { ok: true, value: result.value };
	} catch (err) {
		await advance(
			"failed",
			err instanceof Error ? err.message : String(err),
		).catch(() => undefined);
		throw err;
	} finally {
		acquired.lease.release();
		await refreshMutationBlocks().catch(() => undefined);
	}
}
