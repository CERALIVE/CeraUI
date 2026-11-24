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
import { SteeringUnavailableError } from "./contracts.ts";
import { UplinkSteeringCoordinator } from "./coordinator.ts";
import { buildMarkGuard, MARK_GUARD } from "./mark-admission.ts";
import { fileMarkJournal } from "./mark-journal.ts";
import { SteeringMarkLifecycle } from "./mark-lifecycle.ts";
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
import { MARK_FENCE_RULE } from "./route-policy.ts";
import { readDesiredSteeringState } from "./state-builder.ts";
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

const marks = new SteeringMarkLifecycle({
	journal: fileMarkJournal("/run/ceralive/uplink-steering-marks.json"),
	observe: async () => {
		const nft = await run("nft", ["-nn", "list", "ruleset"]);
		const guard = nft.split(`table inet ${MARK_GUARD} {`)[1]?.split("\n}")[0];
		const legacy =
			nft.split("table inet ceralive_share {")[1]?.split("\n}")[0] ?? "";
		const rules = await run("ip", ["rule", "show"]);
		return {
			guard:
				guard === undefined
					? ""
					: (/\bchain ((?:assignment|fenced)_\d+) \{/.exec(guard)?.[1] ??
						"invalid"),
			legacy,
			fence: MARK_FENCE_RULE.test(rules),
			protectedZones: Array.from(
				(guard ?? "").matchAll(
					/iifname "([A-Za-z0-9_.-]+)" ip saddr (\d+(?:\.\d+){3}\/\d+) drop/g,
				),
				([, ifname, ipv4Cidr]) => ({
					ifname: ifname ?? "",
					ipv4Cidr: ipv4Cidr ?? "",
				}),
			),
		};
	},
	linkIndex: async (ifname) => {
		const output = await run("ip", ["-o", "link", "show", "dev", ifname]);
		const index = /^(\d+):/.exec(output)?.[1];
		if (index === undefined || Number(index) === 0)
			throw new SteeringUnavailableError(
				"policy_route_missing",
				`${ifname}: no live device index`,
			);
		return Number(index);
	},
	armFence: ensureMarkFence,
	guard: async (admission) => {
		publishUplinkSteeringAvailability({
			available: false,
			reason: "ruleset_reload_failed",
		});
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

const coordinator = new UplinkSteeringCoordinator({
	readDesiredState: (context) =>
		readDesiredSteeringState(undefined, {
			...context,
			resolveMarks: (candidates) => marks.marks(candidates),
			planRoute: (candidate) =>
				planUplinkRoute(candidate, { run, journaled: true }),
		}),
	apply: (previous, next) => marks.apply(previous, next),
	hasPendingApply: () => marks.pending,
	retryCleanup: async () => {
		if (!marks.guarded) await applier.retryPendingCleanup();
	},
	publishAvailability: publishUplinkSteeringAvailability,
});

export function committedUplinkSteeringState() {
	return getUplinkSteeringStatus().state === "available"
		? coordinator.appliedState()
		: undefined;
}

let unsubscribeNetif: (() => void) | undefined;
let unsubscribeHealth: (() => void) | undefined;
let unsubscribeScan: (() => void) | undefined;

export async function initUplinkSteering(): Promise<void> {
	if (unsubscribeNetif !== undefined || !(await isRealDevice())) return;
	publishUplinkSteeringAvailability({
		available: false,
		reason: "ruleset_reload_failed",
	});
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
