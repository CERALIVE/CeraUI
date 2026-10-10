import { test } from "bun:test";
import {
	prepareOsStageJob,
	writeOsStageJob,
} from "../../modules/system/update-orchestrator/os-stage-job-files.ts";
import { runOsStageJob } from "../../modules/system/update-orchestrator/os-stage-run.ts";
import { harness } from "./os-stage-run-harness.ts";
import { manifest } from "./os-stage-run-inputs.ts";

test("isolated backend crash boundary", async () => {
	const directory = process.env.OS_STAGE_CRASH_DIRECTORY;
	const boundary = process.env.OS_STAGE_CRASH_BOUNDARY;
	if (!directory || !boundary)
		throw new Error("explicit crash fixture inputs required");
	const pause = async () => {
		process.stdout.write("OS_STAGE_CRASH_READY\n");
		await Promise.withResolvers<void>().promise;
	};
	const h = await harness();
	let waiting = false;
	await runOsStageJob(manifest, h.control, {
		...h.deps,
		owner: (record) => {
			const owner = h.deps.owner(record);
			return {
				...owner,
				acquire: async () => {
					await prepareOsStageJob(record, directory, process.getuid?.() ?? 0);
					await owner.acquire();
				},
				beginAttempt: (snapshot, pair) => {
					owner.beginAttempt(snapshot, pair);
					writeOsStageJob(owner.record(), directory);
				},
				remember: (snapshot, launched, cliSettled, requireNewInstance) => {
					owner.remember(snapshot, launched, cliSettled, requireNewInstance);
					writeOsStageJob(owner.record(), directory);
				},
			};
		},
		restart: async () => {
			await h.deps.restart();
			if (boundary === "restart request") await pause();
		},
		selection: async () => {
			const selected = await h.deps.selection();
			if (h.attempts() === 1 && boundary === "after proof") await pause();
			waiting = h.attempts() === 1 && boundary === "during wait";
			return selected;
		},
		observe: async (...args) => {
			const snapshot = await h.deps.observe(...args);
			return waiting && snapshot
				? { ...snapshot, processes: [...snapshot.processes, "helper:9"] }
				: snapshot;
		},
		sleep: async () => {
			await pause();
		},
		prepareReceipt: async () => {
			if (boundary === "successful CLI") await pause();
			return h.deps.prepareReceipt();
		},
	});
}, 60_000);
