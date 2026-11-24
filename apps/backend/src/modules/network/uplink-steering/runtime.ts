import { uplinkFlowsResetEventSchema } from "@ceraui/rpc/schemas";
import { logger } from "../../../helpers/logger.ts";
import { run, runWithStdin } from "../../../helpers/run.ts";
import { mintLinkId } from "../../modems/physical-identity.ts";
import { isRealDevice } from "../../system/device-detection.ts";
import { broadcastMsg } from "../../ui/websocket-server.ts";
import { onNetworkInterfacesChange } from "../network-interfaces.ts";
import { onUsbNetScanCommitted } from "../router-cellular-scan.ts";
import { onUplinkHealthChange } from "../uplink-health/state.ts";
import {
	applyNftablesRules,
	deactivateUplinkSharing,
	flushConntrack,
	setIpForwarding,
} from "../uplink-sharing.ts";
import { UplinkSteeringApplier } from "./applier.ts";
import { UplinkSteeringCoordinator } from "./coordinator.ts";
import { buildMarkGuard } from "./mark-admission.ts";
import { fileMarkJournal } from "./mark-journal.ts";
import { SteeringMarkLifecycle } from "./mark-lifecycle.ts";
import { observeKernelMarks, readLinkIndex } from "./mark-observation.ts";
import {
	announceCollisionIntents,
	hasJournaledCollision,
} from "./mark-recovery.ts";
import {
	discoverMarkInventory,
	discoverOwnedUplinkRoutes,
	ensureMarkFence,
	ensureUplinkRoute,
	planUplinkRoute,
	removeUplinkRoute,
	retireMarkSupport,
	rollbackUplinkRoute,
} from "./route-manager.ts";
import {
	readDesiredSteeringState,
	type SteeringReadinessContext,
} from "./state-builder.ts";
import {
	getUplinkSteeringStatus,
	publishUplinkSteeringAvailability,
	UPLINK_FLOWS_RESET_EVENT,
} from "./status.ts";

const applier = new UplinkSteeringApplier({
	discoverRoutes: discoverOwnedUplinkRoutes,
	ensureRoute: ensureUplinkRoute,
	rollbackRoute: rollbackUplinkRoute,
	removeRoute: removeUplinkRoute,
	applyRuleset: (ruleset, mode) => applyNftablesRules(ruleset, undefined, mode),
	deactivateSharing: deactivateUplinkSharing,
	flushConntrack,
	setIpForwarding,
	publishFlowsReset: (event) =>
		broadcastMsg(
			UPLINK_FLOWS_RESET_EVENT,
			uplinkFlowsResetEventSchema.parse(event),
		),
});

// Only collision paths journal an affected intent or install a guard, so a
// non-colliding device keeps main's status timeline.
const unverified = () =>
	publishUplinkSteeringAvailability({
		available: false,
		reason: "ruleset_reload_failed",
	});
const journal = announceCollisionIntents(
	fileMarkJournal("/run/ceralive/uplink-steering-marks.json"),
	unverified,
);

const marks = new SteeringMarkLifecycle({
	journal,
	observe: () => observeKernelMarks(run),
	linkIndex: (ifname) => readLinkIndex(run, ifname),
	armFence: ensureMarkFence,
	guard: async (admission) => {
		unverified();
		await runWithStdin("nft", ["-f", "-"], buildMarkGuard(admission));
	},
	retire: retireMarkSupport,
	inventory: discoverMarkInventory,
	ensure: (route) => ensureUplinkRoute(route, { run, journaled: true }),
	flush: flushConntrack,
	publish: async (ruleset, active) => {
		await setIpForwarding(active);
		await applyNftablesRules(ruleset, undefined, "activate", true);
	},
	applyLegacy: (previous, next) => applier.apply(previous, next),
	notifyRetired: (claim) =>
		broadcastMsg(
			UPLINK_FLOWS_RESET_EVENT,
			uplinkFlowsResetEventSchema.parse({
				iface: claim.ifname,
				linkId: mintLinkId(claim.identity),
			}),
		),
});

const planRoute: NonNullable<SteeringReadinessContext["planRoute"]> = (
	candidate,
) =>
	marks.guarded
		? planUplinkRoute(candidate, { run, journaled: true })
		: planUplinkRoute(candidate);

const coordinator = new UplinkSteeringCoordinator({
	readDesiredState: (context) =>
		readDesiredSteeringState(undefined, {
			...context,
			resolveMarks: (candidates) => marks.marks(candidates),
			planRoute,
		}),
	apply: (previous, next) => marks.apply(previous, next),
	hasPendingApply: () => marks.pending,
	needsRecheck: () => marks.blocked || marks.unverified,
	retryCleanup: async () => {
		if (!marks.guarded) await applier.retryPendingCleanup();
	},
	// A waiting contender reports what main reports for the collision, and
	// unverified marks report what a failed kernel read reports.
	publishAvailability: (status) =>
		publishUplinkSteeringAvailability(
			!status.available
				? status
				: marks.blocked
					? {
							available: false,
							reason: "mark_collision",
							detail: "a same-mark link waits for verified steering marks",
						}
					: marks.unverified
						? {
								available: false,
								reason: "ruleset_reload_failed",
								detail:
									"steering marks are unverified until the kernel is read",
							}
						: status,
		),
});

export const shaperSteeringContext: SteeringReadinessContext = {
	resolveMarks: async (candidates) => {
		const committed =
			getUplinkSteeringStatus().state === "available" && !marks.pending
				? coordinator.appliedState()
				: undefined;
		const assignments = new Map<string, number>();
		for (const { identity, ifname, mark } of candidates) {
			const affected =
				marks.affects(mark) ||
				candidates.filter((link) => link.mark === mark).length > 1;
			if (!affected) {
				assignments.set(identity, mark);
				continue;
			}
			const owner = committed?.uplinks.find(
				(link) => link.identity === identity && link.ifname === ifname,
			);
			if (owner !== undefined) assignments.set(identity, owner.mark);
		}
		return assignments;
	},
	planRoute,
};

let unsubscribeNetif: (() => void) | undefined;
let unsubscribeHealth: (() => void) | undefined;
let unsubscribeScan: (() => void) | undefined;

export async function initUplinkSteering(): Promise<void> {
	if (unsubscribeNetif !== undefined || !(await isRealDevice())) return;
	if (await hasJournaledCollision(journal)) unverified();
	const reconcile = () => {
		void coordinator.requestReconcile().catch((error: unknown) => {
			logger.warn("uplink steering reconcile failed", { err: error });
		});
	};
	unsubscribeNetif = onNetworkInterfacesChange(reconcile);
	unsubscribeHealth = onUplinkHealthChange(reconcile);
	unsubscribeScan = onUsbNetScanCommitted(reconcile);
	await coordinator.requestReconcile();
}

export function requestUplinkSteeringReconcile(): Promise<void> {
	return coordinator.requestReconcile();
}

export function stopUplinkSteeringForTest(): void {
	unsubscribeNetif?.();
	unsubscribeHealth?.();
	unsubscribeScan?.();
	coordinator.stop();
	unsubscribeNetif = undefined;
	unsubscribeHealth = undefined;
	unsubscribeScan = undefined;
}
