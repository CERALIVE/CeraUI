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
 * The ONE entrypoint every capability module's mutating path routes through.
 *
 * It is a WRAPPER over the shared mutation-safety contract, never a second guard
 * beside it: the lease, the reciprocal streaming refusal, the durable journal and
 * the crash-surviving rollback all remain `mutation-lease.ts`'s. What this adds is
 * the FEATURE GATE — a module whose device-config gate is off, or whose capability
 * this modem cannot be shown to have, is refused with its own typed reason BEFORE
 * a lease is taken and before anything is journaled.
 *
 * The gate runs FIRST, and that ordering is the same one the USB-mode catalog
 * check already follows: a request that is doomed on a pure read must not contend
 * for a device lease, and an operator who has not enabled a module must be told
 * that rather than told the device is busy.
 *
 * Whether a module is journaled is decided by the shared
 * `JOURNALED_CAPABILITY_MODULES` set and enforced BY THE TYPE SYSTEM: the request
 * is a discriminated union in which a journaled module MUST carry a `preState` and
 * a lease-only one cannot. A module that can cost the bond link therefore has no
 * way to opt itself out of a rollback — it would not compile.
 */

import type {
	CapabilityModule,
	CapabilityMutationRefusal,
	JournaledCapabilityModule,
	LeaseOnlyCapabilityModule,
	SupportClaimState,
} from "@ceraui/rpc/schemas";
import { CAPABILITY_MODULE_MUTATION_KIND } from "@ceraui/rpc/schemas";

import { resolveCapabilityModuleState } from "./capability-gates.ts";
import {
	type JournaledMutation,
	withJournaledModemMutation,
	withModemMutation,
} from "./mutation-lease.ts";

export type CapabilityMutationOutcome<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly refusal: CapabilityMutationRefusal };

export type CapabilityMutationRequest =
	| {
			readonly module: JournaledCapabilityModule;
			readonly stableKey: string | undefined;
			/** The kind-specific snapshot a crash-surviving rollback restores TO. */
			readonly preState: Readonly<Record<string, unknown>>;
			readonly implemented?: readonly CapabilityModule[];
	  }
	| {
			readonly module: LeaseOnlyCapabilityModule;
			readonly stableKey: string | undefined;
			readonly implemented?: readonly CapabilityModule[];
	  };

export type CapabilityMutationResult<T> = {
	/** Journaled modules only: `false` leaves the device blocked, fail-closed. */
	readonly confirmed: boolean;
	readonly value: T;
	readonly detail?: string;
};

export type CapabilityMutationContext = {
	/** Present only for journaled modules — the armed entry's transition hooks. */
	readonly journal?: JournaledMutation;
};

/**
 * EXHAUSTIVE on purpose: a sixth support state added later must fail to compile
 * here rather than fall silently into `module_unavailable`, which would refuse a
 * module without anyone deciding that it should be refused.
 */
export function capabilityMutationRefusal(
	state: SupportClaimState,
): CapabilityMutationRefusal | undefined {
	switch (state) {
		case "capable":
		case "certified":
			return undefined;
		case "implemented":
			return "module_disabled";
		case "enabled":
		case "unavailable":
			return "module_unavailable";
		default: {
			const unreachable: never = state;
			return unreachable;
		}
	}
}

export async function withCapabilityModuleMutation<T>(
	request: CapabilityMutationRequest,
	run: (
		context: CapabilityMutationContext,
	) => Promise<CapabilityMutationResult<T>>,
): Promise<CapabilityMutationOutcome<T>> {
	const state = resolveCapabilityModuleState(
		request.module,
		request.stableKey,
		request.implemented,
	);
	const refusal = capabilityMutationRefusal(state);
	if (refusal !== undefined) {
		return { ok: false, refusal };
	}

	if ("preState" in request) {
		return withJournaledModemMutation(
			request.stableKey,
			CAPABILITY_MODULE_MUTATION_KIND[request.module],
			request.preState,
			(journal) => run({ journal }),
		);
	}

	return withModemMutation(request.stableKey, async () => {
		const result = await run({});
		return result.value;
	});
}
