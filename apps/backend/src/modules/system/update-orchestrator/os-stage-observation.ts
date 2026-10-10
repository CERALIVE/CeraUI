import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import { spawnWithTimeout } from "../../../helpers/spawn-policy.ts";
import { readBootId } from "./os-identity.ts";
import {
	describeObservationFailure,
	failedAdmissionPredicate,
	notifyObservation,
	type ObservationReport,
	STAGE_CENSUS_DRIFT,
} from "./os-stage-admission-diagnostics.ts";
import {
	observeStageCensus,
	readStageProcess,
	sameStageSet,
} from "./os-stage-census.ts";
import {
	collectStageMembers,
	rememberStageEvidence,
} from "./os-stage-process-evidence.ts";
import type { RaucStageSnapshot } from "./os-stage-recovery.ts";
import { parseOsStageSystemdProperties } from "./os-stage-systemd.ts";
import { readHealthyState } from "./slot-sync-state.ts";

const slotsSchema = z.object({
	boot_primary: z.string().nullish(),
	slots: z.array(
		z.record(
			z.string(),
			z.object({
				class: z.string(),
				state: z.string(),
				device: z.string(),
				bootname: z.string().nullish(),
				boot_status: z.string().nullish(),
			}),
		),
	),
});

export type RaucObservationDeps = {
	readonly read: (path: string) => Promise<string>;
	readonly list: (path: string) => Promise<string[]>;
	readonly run: typeof spawnWithTimeout;
	readonly device: (path: string) => Promise<string>;
	readonly rootDevice: () => Promise<string>;
	readonly bootId: () => Promise<string>;
	readonly healthy: typeof readHealthyState;
};
const defaults: RaucObservationDeps = {
	read: (path) => Bun.file(path).text(),
	list: readdir,
	run: spawnWithTimeout,
	device: async (path) => String((await stat(path)).rdev),
	rootDevice: async () => String((await stat("/")).dev),
	bootId: readBootId,
	healthy: readHealthyState,
};

function absent(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function processIdentity(pid: string, raw: string): string {
	const tail = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
	const ticks = tail[19];
	if (!/^[1-9][0-9]*$/.test(pid) || !ticks || !/^[0-9]+$/.test(ticks))
		throw new Error("process identity unreadable");
	return `${pid}:${ticks}`;
}

export async function observeRaucStage(
	tracked: {
		readonly processes: ReadonlySet<string>;
		readonly resources: ReadonlySet<string>;
	},
	deps: RaucObservationDeps = defaults,
	report?: ObservationReport,
): Promise<RaucStageSnapshot | null> {
	const started = performance.now();
	const rawEvidence = new Map<string, string>();
	let stage = "service-command";
	const at = (next: string) => {
		stage = next;
	};
	const refuse = (): null => {
		notifyObservation(report, `${stage}: unproven`);
		return null;
	};
	try {
		const service = await deps.run(
			[
				"systemctl",
				"show",
				"rauc.service",
				"--property=ActiveState,MainPID,ControlGroup,InvocationID",
			],
			{ timeoutMs: 2_000 },
		);
		at("service-properties");
		const properties = parseOsStageSystemdProperties(service.stdout);
		if (!properties) return refuse();
		const group = properties.get("ControlGroup");
		const pid = properties.get("MainPID") ?? "";
		if (
			service.exitCode !== 0 ||
			!group ||
			!/^\/system.slice\/rauc.service$/.test(group)
		)
			return refuse();
		at("daemon-process");
		const instance = await readStageProcess(pid, deps);
		if (!instance) return refuse();
		const census = await observeStageCensus({
			deps,
			tracked,
			group,
			raw: rawEvidence,
			at,
		});
		if (!census) return refuse();
		const { pids, processIds, resources } = census;
		at("operation-command");
		const operation = await deps.run(
			[
				"busctl",
				"get-property",
				"de.pengutronix.rauc",
				"/",
				"de.pengutronix.rauc.Installer",
				"Operation",
			],
			{ timeoutMs: 2_000 },
		);
		at("status-command");
		const status = await deps.run(
			["rauc", "status", "--detailed", "--output-format=json"],
			{ timeoutMs: 2_000 },
		);
		if (status.exitCode !== 0) return refuse();
		at("status-parse");
		const parsed = slotsSchema.parse(JSON.parse(status.stdout));
		at("slot-cardinality");
		const rootfs = parsed.slots
			.flatMap((row) => Object.entries(row))
			.filter(([, slot]) => slot.class === "rootfs");
		const booted = rootfs.filter(([, slot]) => slot.state === "booted");
		const target = rootfs.filter(([, slot]) => slot.state === "inactive");
		if (rootfs.length !== 2 || booted.length !== 1 || target.length !== 1)
			return refuse();
		const boot = booted[0];
		const other = target[0];
		if (!boot || !other) return refuse();
		at("boot-id");
		const bootId = await deps.bootId();
		at("healthy-state");
		const healthy = await deps.healthy();
		at("booted-device");
		const bootedDevice = await deps.device(boot[1].device);
		at("root-device");
		const rootDevice = await deps.rootDevice();
		at("activation-marker");
		let activationArmed = true;
		try {
			await deps.read("/data/ceralive/update-state/activation-armed");
		} catch (error) {
			if (!absent(error)) throw error;
			activationArmed = false;
		}
		at("target-device");
		const targetDevice = await deps.device(other[1].device);
		const snapshot: RaucStageSnapshot = {
			instance,
			active: properties.get("ActiveState") === "active",
			operation:
				operation.exitCode === 0
					? (/^s "([^"\n]+)"\s*$/.exec(operation.stdout)?.[1] ?? null)
					: null,
			processes: [...processIds],
			resources: [...resources],
			bootId,
			bootPrimary:
				rootfs.filter(([name]) => name === parsed.boot_primary).length === 1
					? (parsed.boot_primary ?? null)
					: null,
			bootedSlot: boot[0],
			bootedDevice,
			bootedHealthy:
				bootedDevice === rootDevice &&
				boot[1].boot_status === "good" &&
				healthy?.boot_id === bootId &&
				(healthy.slot === boot[0] || healthy.slot === boot[1].bootname),
			targetSlot: other[0],
			targetDevice,
			targetInactive: other[1].state === "inactive",
			activationArmed,
		};
		const invocation = properties.get("InvocationID");
		const members = await collectStageMembers({
			identities: processIds,
			listed: pids,
			raw: rawEvidence,
			read: deps.read,
		});
		at("final-service-command");
		const finalService = await deps.run(
			[
				"systemctl",
				"show",
				"rauc.service",
				"--property=ActiveState,MainPID,ControlGroup,InvocationID",
			],
			{ timeoutMs: 2_000 },
		);
		const finalProperties = parseOsStageSystemdProperties(finalService.stdout);
		if (
			finalService.exitCode !== 0 ||
			!finalProperties ||
			["ActiveState", "MainPID", "ControlGroup", "InvocationID"].some(
				(key) => finalProperties.get(key) !== properties.get(key),
			)
		)
			return refuse();
		const finalCensus = await observeStageCensus({ deps, tracked, group, at });
		if (!finalCensus) return refuse();
		if (
			!sameStageSet(processIds, finalCensus.processIds) ||
			!sameStageSet(resources, finalCensus.resources)
		) {
			// This projection checks non-census evidence only; it is never returned.
			const refusal = failedAdmissionPredicate({
				...snapshot,
				processes: [instance],
				resources: [],
			});
			notifyObservation(
				report,
				refusal ? `${refusal}: unproven` : STAGE_CENSUS_DRIFT,
			);
			return null;
		}
		rememberStageEvidence(snapshot, {
			started,
			finished: performance.now(),
			mainPid: pid,
			invocationId:
				invocation && /^[a-f0-9]{32}$/.test(invocation) ? invocation : null,
			members,
		});
		return snapshot;
	} catch (error) {
		// Observation failure never authorizes cancellation, cleanup or another
		// writer; the bounded diagnostic only names where it stopped.
		notifyObservation(report, describeObservationFailure(stage, error));
		return null;
	}
}
