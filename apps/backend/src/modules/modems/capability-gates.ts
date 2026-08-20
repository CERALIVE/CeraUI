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
 * Where the device-config gate meets the per-modem capability evidence.
 *
 * The taxonomy and the ladder live in `@ceraui/rpc` because the frontend and the
 * support matrix read them too; this module is the DEVICE-side binding: it reads
 * the persisted gates, asks the evidence reader what this particular modem can
 * do, and resolves the total seven-module claim matrix for it.
 *
 * The evidence reader is a SEAM with a deliberately empty default. No module is
 * implemented yet, so every modem resolves `unavailable` today — the honest
 * answer, and the thing that stops a config gate from surfacing a control with
 * nothing behind it. Each of the seven modules registers its own probe when it
 * lands.
 */

import { resolveCapabilityMatrix } from "@ceraui/rpc";
import type {
	CapabilityEvidence,
	CapabilityModule,
	CapabilityModuleClaims,
	SupportClaimState,
} from "@ceraui/rpc/schemas";
import { readCapabilityGates } from "@ceraui/rpc/schemas";

import { getConfig } from "../config.ts";

export type ModemCapabilityEvidence = {
	readonly capability: Partial<Record<CapabilityModule, CapabilityEvidence>>;
	readonly certified?: Partial<Record<CapabilityModule, boolean>>;
};

export type ModemCapabilityEvidenceReader = (
	stableKey: string | undefined,
) => ModemCapabilityEvidence;

const NO_EVIDENCE: ModemCapabilityEvidence = { capability: {} };

let evidenceReader: ModemCapabilityEvidenceReader = () => NO_EVIDENCE;

export function setModemCapabilityEvidenceReader(
	reader: ModemCapabilityEvidenceReader | null,
): void {
	evidenceReader = reader ?? (() => NO_EVIDENCE);
}

/**
 * FAIL-OPEN on a throwing reader: a probe that broke is a statement about the
 * READ, and an unreadable probe leaves every module at `unknown`, which the
 * ladder already stops at `enabled` — surfaced by nothing, mutated by nothing.
 */
function readEvidence(stableKey: string | undefined): ModemCapabilityEvidence {
	try {
		return evidenceReader(stableKey);
	} catch {
		return NO_EVIDENCE;
	}
}

export function resolveModemCapabilityClaims(
	stableKey: string | undefined,
	implemented?: readonly CapabilityModule[],
): CapabilityModuleClaims {
	const evidence = readEvidence(stableKey);
	return resolveCapabilityMatrix({
		...(implemented === undefined ? {} : { implemented }),
		gates: readCapabilityGates(getConfig().modem_capabilities),
		capability: evidence.capability,
		...(evidence.certified === undefined
			? {}
			: { certified: evidence.certified }),
	});
}

export function resolveCapabilityModuleState(
	module: CapabilityModule,
	stableKey: string | undefined,
	implemented?: readonly CapabilityModule[],
): SupportClaimState {
	return resolveModemCapabilityClaims(stableKey, implemented)[module];
}
