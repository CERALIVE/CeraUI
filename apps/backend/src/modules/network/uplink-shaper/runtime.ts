import { rename } from "node:fs/promises";
import { logger } from "../../../helpers/logger.ts";
import { buildLinkTelemetry } from "../../streaming/link-telemetry.ts";
import { getStreamLifecycleState } from "../../streaming/stream-lifecycle-status.ts";
import { isRealDevice } from "../../system/device-detection.ts";
import { applyTrafficControl } from "../uplink-sharing.ts";
import { readDesiredSteeringState } from "../uplink-steering/state-builder.ts";
import { type RootQdisc, UplinkShaperApplier } from "./applier.ts";
import { SHAPER_OWNERSHIP_PATH } from "./contracts.ts";
import { UplinkShaperCoordinator } from "./coordinator.ts";
import { readShaperOwnership } from "./ownership-authority.ts";
import { publishShaperAvailable, publishShaperUnavailable } from "./status.ts";
import { readClientBacklog, readRootQdisc } from "./tc-runtime.ts";

const applier = new UplinkShaperApplier({
	readRoot: readRootQdisc,
	runTc: async (argv) => {
		await applyTrafficControl(argv);
	},
	readBacklog: readClientBacklog,
	readRecordedRoots,
	writeRecordedRoots,
});

let enabled = false;
let mode: "idle" | "streaming" = "idle";

const coordinator = new UplinkShaperCoordinator({
	apply: async (request) => {
		const algorithm = await applier.apply(request);
		mode = request.mode;
		publishShaperAvailable(request.mode, algorithm);
	},
	readBacklog: (ifname) => applier.clientBacklog(ifname),
});

export async function initUplinkShaper(): Promise<void> {
	enabled = await isRealDevice();
	if (enabled) await tickUplinkShaper();
}

export async function tickUplinkShaper(): Promise<void> {
	if (!enabled) return;
	try {
		const steering = await readDesiredSteeringState();
		const telemetry = buildLinkTelemetry()?.links ?? [];
		await coordinator.update({
			streaming: getStreamLifecycleState() === "streaming",
			sharedUplinks: steering.uplinks.map((uplink) => ({
				identity: uplink.identity,
				ifname: uplink.ifname,
				mark: uplink.mark,
			})),
			telemetry: telemetry.map((sample) => ({
				iface: sample.iface,
				rttMs: sample.rtt_ms,
				nakCount: sample.nak_count,
				stale: sample.stale,
			})),
		});
	} catch (error) {
		publishShaperUnavailable(error);
		logger.warn("uplink shaper unavailable; client sharing remains unshaped", {
			err: error,
		});
	}
}

export async function stopUplinkShaper(): Promise<void> {
	if (!enabled) return;
	enabled = false;
	await applier.teardown();
}

export function getUplinkShaperMode(): "idle" | "streaming" {
	return mode;
}

async function readRecordedRoots(): Promise<Record<string, RootQdisc>> {
	return readShaperOwnership(SHAPER_OWNERSHIP_PATH);
}

async function writeRecordedRoots(
	roots: Record<string, RootQdisc>,
): Promise<void> {
	const temp = `${SHAPER_OWNERSHIP_PATH}.${process.pid}.tmp`;
	await Bun.write(temp, `${JSON.stringify(roots)}\n`);
	await rename(temp, SHAPER_OWNERSHIP_PATH);
}
