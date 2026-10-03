import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { OsStageError } from "../../modules/system/update-orchestrator/os-stage-error.ts";
import {
	type RaucStageSnapshot,
	raucQuiescenceRefusal,
} from "../../modules/system/update-orchestrator/os-stage-recovery.ts";
import type { OsStageRunDeps } from "../../modules/system/update-orchestrator/os-stage-run.ts";
import {
	createUpdatePinController,
	UpdateTransferError,
} from "../../modules/system/update-transport/pin.ts";
import { baseline, ranking } from "./os-stage-run-inputs.ts";
import { acquireTestOsStageControl } from "./os-stage-test-control.ts";

export async function harness() {
	const events: string[] = [];
	const signal = new AbortController();
	let snapshot = baseline;
	let selections = 0;
	let attempts = 0;
	let now = 0;
	const pin = createUpdatePinController({
		readCapabilities: async () =>
			updateCapabilityFileSchema.parse({
				schema: 1,
				features: ["apt-all-packages", "transport-uidrange"],
				apt_uid: 42042,
				ota_uid: 42043,
			}),
		now: () => now,
		run: async (_bin, args) => {
			const value = args.join(" ");
			events.push(value);
			return value.endsWith("route show default")
				? "default dev wlan0\ndefault dev eth0\ndefault dev wwan0\n"
				: "";
		},
	});
	await pin.sweep();
	events.length = 0;
	const deps: OsStageRunDeps<string> = {
		acquireControl: acquireTestOsStageControl,
		pin,
		now: () => now,
		sleep: async (ms) => {
			now += ms;
		},
		blocked: async () => false,
		observe: async () => snapshot,
		selection: async () => {
			events.push("select");
			selections++;
			return ranking(selections === 1 ? ["wlan0"] : ["eth0"]);
		},
		revalidate: async () => {
			events.push("revalidate");
		},
		readProgress: async () => 56,
		progress: () => {
			// This fixture observes receipt publication rather than progress frames.
		},
		restart: async () => {
			events.push("restart-submitted");
			snapshot = {
				...baseline,
				instance: `new:${attempts}`,
				processes: [`new:${attempts}`],
			};
		},
		prepareReceipt: async () => {
			events.push("prepare-receipt");
			return () => {
				events.push("receipt+serial+OS_STAGED");
				return "receipt";
			};
		},
		owner: (input) => {
			let record = input;
			let held = false;
			return {
				acquire: async () => {
					events.push("acquire");
					held = true;
				},
				held: async () => held,
				remember: (
					current,
					launched = true,
					cliSettled = false,
					requireNewInstance = false,
				) => {
					record = {
						...record,
						processes: [
							...new Set([...record.processes, ...current.processes]),
						],
						resources: [
							...new Set([...record.resources, ...current.resources]),
						],
						launched,
						cliSettled,
						requireNewInstance,
					};
				},
				beginAttempt: (current, pair) => {
					events.push(`begin:${pair}`);
					record = {
						...record,
						baseline: current,
						processes: [...current.processes],
						resources: [],
						launched: true,
						cliSettled: false,
						requireNewInstance: false,
						pair,
					};
				},
				record: () => record,
				release: async (current, clean, settle) => {
					const refusal = raucQuiescenceRefusal({
						ownership: {
							baseline: record.baseline,
							processes: new Set(record.processes),
							resources: new Set(record.resources),
						},
						current,
						cliSettled: record.cliSettled,
						lockHeld: held,
						requireNewInstance: record.requireNewInstance,
					});
					if (refusal || !clean)
						throw new OsStageError("rauc_recovery_unproven");
					settle?.();
					events.push("release");
					held = false;
				},
			};
		},
		attempt: () => {
			attempts++;
			events.push(`install:${attempts}`);
			const transfer = new UpdateTransferError("no-route");
			return {
				outcome: Promise.resolve(
					attempts === 1
						? {
								kind: "failed" as const,
								error: new OsStageError("os_transport_failed"),
								transfer,
							}
						: {
								kind: "succeeded" as const,
								result: { exitCode: 0, stdout: "success", stderr: "" },
							},
				),
				cli: Promise.resolve({
					exitCode: attempts === 1 ? 1 : 0,
					stdout: "",
					stderr: "",
				}),
				cliSettled: () => true,
				dispose: () => {
					// Attempts contain no subprocess or stream resources in this fixture.
				},
			};
		},
	};
	return {
		deps,
		events,
		control: {
			attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			signal: signal.signal,
		},
		signal,
		attempts: () => attempts,
		now: () => now,
		makeReady: () => {
			snapshot = {
				...baseline,
				instance: "retired:100",
				processes: ["retired:100"],
			};
		},
		setSnapshot: (value: RaucStageSnapshot) => {
			snapshot = value;
		},
	};
}
