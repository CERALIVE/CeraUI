/**
 * `system.getUpdateDetails` (Todo 41) — the ONE read the Updates dialog uses for
 * everything the status push does not carry: both RAUC slots, the booted /
 * staged / candidate OS versions, the package and OS check clocks, a pending
 * one-time cellular approval, and the last update-transport selection.
 *
 * It is a thin aggregator over readers other todos already built and tested
 * (`readBothSlotStatus`, `readBootedOsReleaseVersion`, `readStagedReceipt`, the
 * orchestrator state, the transport recorder). It owns no policy and performs
 * no mutation; every reader that can fail degrades to `null` independently, so
 * one unreadable source never blanks the whole dialog.
 *
 * It is ADDITIVE and SEPARATE from `device-stats.raucSlot` — that S1-locked
 * scalar is untouched. Honest-absence rules, each load-bearing:
 * - `slots` is `null` unless the image declares `slot-sync` AND `rauc status`
 *   answered. A legacy image has no mirror, so its "last sync" would be a
 *   claim nothing measured.
 * - `os.staged` is reported only while the orchestrator is in a phase where a
 *   staged-but-not-yet-verified image is real; the receipt survives activation,
 *   and presenting it afterwards would call a booted image "pending restart".
 * - `transport` is `null` until the selector has run at least once.
 */
import type { UpdateCapabilities, UpdateDetails } from "@ceraui/rpc/schemas";

import { logger } from "../../../helpers/logger.ts";
import { readUpdateCapabilities } from "../update-capabilities.ts";
import { getLastTransportSelection } from "../update-transport/last-selection.ts";
import { readStagedReceipt } from "./os-agent.ts";
import { readBootedOsReleaseVersion } from "./os-manifest.ts";
import { getOrchestratorState, getOsUpdateSummary } from "./runtime.ts";
import { type RootSlotStatus, readBothSlotStatus } from "./slot-status.ts";
import type { OrchestratorPhase, OrchestratorState } from "./types.ts";

const STAGED_PHASES: ReadonlySet<OrchestratorPhase> = new Set([
	"os-staged",
	"os-activation-armed",
	"os-verifying",
]);

export type UpdateDetailsDeps = {
	readonly loadCapabilities: () => Promise<UpdateCapabilities>;
	readonly readSlots: () => Promise<readonly RootSlotStatus[]>;
	readonly readBootedVersion: () => Promise<string | undefined>;
	readonly readStagedReceipt: () => Promise<
		{ readonly version: string; readonly stagedAt: number } | undefined
	>;
	readonly orchestratorState: () => OrchestratorState;
	readonly osSummary: typeof getOsUpdateSummary;
	readonly lastTransport: typeof getLastTransportSelection;
};

export const defaultUpdateDetailsDeps: UpdateDetailsDeps = {
	loadCapabilities: readUpdateCapabilities,
	readSlots: () => readBothSlotStatus(),
	readBootedVersion: () => readBootedOsReleaseVersion(),
	readStagedReceipt,
	orchestratorState: getOrchestratorState,
	osSummary: getOsUpdateSummary,
	lastTransport: getLastTransportSelection,
};

async function settle<T>(
	label: string,
	read: () => Promise<T>,
): Promise<T | undefined> {
	try {
		return await read();
	} catch (error) {
		logger.debug("update-details: reader unavailable", { label, error });
		return undefined;
	}
}

export async function readUpdateDetails(
	deps: UpdateDetailsDeps = defaultUpdateDetailsDeps,
): Promise<UpdateDetails> {
	const state = deps.orchestratorState();
	const capabilities = await settle("capabilities", deps.loadCapabilities);
	const slotSync =
		capabilities?.mode === "capable" &&
		capabilities.features.includes("slot-sync");
	const [slots, bootedVersion, receipt] = await Promise.all([
		slotSync ? settle("slots", deps.readSlots) : Promise.resolve(undefined),
		settle("booted-version", deps.readBootedVersion),
		STAGED_PHASES.has(state.phase)
			? settle("staged-receipt", deps.readStagedReceipt)
			: Promise.resolve(undefined),
	]);
	const os = deps.osSummary();
	const clock = (c: OrchestratorState["packageCheck"]) => ({
		lastAttemptAt: c.lastAttemptAt,
		lastSuccessAt: c.lastSuccessAt,
		nextAttemptAt: c.nextAttemptAt,
	});
	return {
		slots: slots ? slots.map((slot) => ({ ...slot })) : null,
		os: {
			bootedVersion: bootedVersion ?? null,
			staged: receipt
				? { version: receipt.version, stagedAt: receipt.stagedAt }
				: null,
			candidate: os.candidate,
		},
		checks: {
			packages: clock(state.packageCheck),
			os: clock(state.osCheck),
		},
		pendingCellular: os.pendingCellular,
		transport: deps.lastTransport() ?? null,
	};
}
